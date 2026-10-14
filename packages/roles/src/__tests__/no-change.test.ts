import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeResult, AssistantTurn, DagNode,
  ToolCallRecord, TaskId, PolicyDecision,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, makeTaskId, makeAgentId, NodeFailure, TransportError } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { HarnessConfigError } from '@maf/harness-config';
import type { HarnessConfig, HarnessRoleConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { SecurityReviewGate } from '@maf/git-ops';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry, RoleConfigError } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';
import type { RoleConfig } from '../RoleConfig.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';
import { roleSetFromHarness } from '../harnessBridge.js';

// ORACLE: D-32 — a role says whether it is expected to change the tree, on either tier. A cli-tier backend that
// runs under the user's own permission settings can refuse the edit, say so, and exit 0; D-04
// read that as success. A node whose role expects a change and whose diff against the start
// commit is empty now fails with NodeFailure('no_change'), the output tail in the error. Only the
// built-in coder expects a change; the diff is the one the security gate reads (D-29) against the
// baseline captured once per node (D-06).

const execFileAsync = promisify(execFile);

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

/** A cli-tier backend whose every call is scripted: what it does to the tree, and what it says. */
class ScriptedCli implements CliAdapter {
  readonly name = 'scripted-cli';
  readonly script: Array<() => Promise<void>> = [];
  reply: AdapterInvokeResult = {
    success: true, toolCallLog: [], exitCode: 0, duration: 1,
    output: 'I was not permitted to edit hello.txt, so I left it unchanged.',
  };
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    const step = this.script.shift();
    if (step) await step();
    return this.reply;
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

/** An in-process backend that plays `turns`, one per call, then answers with `final`. */
class ScriptedTurns extends ScriptedCli implements TurnAdapter {
  constructor(private readonly turns: AssistantTurn[] = [], private readonly final = 'nothing to do') { super(); }
  override capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: true }; }
  async sendTurn(): Promise<AssistantTurn> { return this.turns.shift() ?? { text: this.final, toolCalls: [] }; }
}

/** One turn making one tool call. */
function calling(toolName: string, input: Record<string, unknown>, n: number): AssistantTurn {
  return { text: `call ${n}`, toolCalls: [{ toolUseId: `u${n}`, toolName, input }] };
}

/**
 * An attestor that keeps every call it was handed (F10). `executeToolGated` records a refused call
 * through the same `record` it records a run one, so a node's own denied calls are read back here by
 * taskId — the `policyDecision` still carries the `Deny` and its `ruleId`.
 */
class RecordingAttestor {
  readonly calls: ToolCallRecord[] = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> {
    this.calls.push({ id: `rec-${this.calls.length}`, ...call });
  }
  toolCallsForTask(taskId: TaskId): ToolCallRecord[] {
    return this.calls.filter((call) => call.taskId === taskId);
  }
  recordSecurityFindings(): void {}
}

/** A policy engine that refuses one tool by a named rule and allows every other call. */
function denyingPolicy(toolId: string, ruleId: string): PolicyEngine {
  return {
    evaluate: async (id: unknown): Promise<PolicyDecision> =>
      String(id) === toolId ? { verdict: 'Deny', reason: 'forbidden by test policy', ruleId } : { verdict: 'Allow' },
  } as unknown as PolicyEngine;
}

/**
 * Three calls that each fail without changing the tree, as WP-2.18 answers them: a read of a file
 * that is not there, a write into a directory that is not there, a write with a field misnamed.
 */
function failingCalls(): AssistantTurn[] {
  return [
    calling('fs.read', { path: 'missing.txt' }, 1),
    calling('fs.write', { path: 'nowhere/hello.txt', content: 'hi' }, 2),
    calling('fs.write', { path: 'hello.txt', text: 'hi' }, 3),
  ];
}

const WRITER_TOOLS = ['fs.read', 'fs.write', 'git.commit'];

function roleNamed(name: string, extra: Partial<RoleConfig> = {}): RoleConfig {
  return {
    role: defineRoleName(name), systemPrompt: 'work',
    allowedTools: WRITER_TOOLS.map(makeToolId), ...extra,
  };
}

function nodeFor(name: string, id = `${name}-1`): DagNode {
  return {
    id: makeNodeId(id), label: 'change hello.txt', agentRole: defineRoleName(name), dependencies: [],
    retryPolicy: { maxAttempts: 2, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {}, metadata: { taskDescription: 'change hello.txt' },
  };
}

interface Fixture {
  dispatcher: RoleDispatcher;
  workDir:    string;
  reviewed:   string[];
  cleanup:    () => Promise<void>;
}

async function makeFixture(
  role: RoleConfig,
  adapter: CliAdapter,
  deps: { policy?: PolicyEngine; attestor?: Attestor } = {},
): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-no-change-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await commitAll(workDir, 'base');
  const reviewed: string[] = [];
  const dispatcher = new RoleDispatcher({
    adapter,
    baseTools: createDefaultRegistry(),
    roles: RoleRegistry.fromSet({ version: 1, defaultRole: role.role, roles: [role] }, workDir),
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: deps.policy ?? { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: deps.attestor ?? { record: async () => {}, recordSecurityFindings: () => {} } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: { append: async () => {} } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    securityGate: {
      reviewDiff: async (diff: string) => { reviewed.push(diff); return { findings: [], summary: 'clean', passed: true }; },
    } as unknown as SecurityReviewGate,
    cwd: workDir,
    sessionId: 's1',
    runId: makeRunId('run-no-change'),
    harness: { processorBundles: [] } as unknown as HarnessConfig,
    // A writer on a backend with no in-process loop: the cli tier needs the run's consent (D-01).
    allowUngoverned: true,
    stderr: { write: () => true },
  });
  return { dispatcher, workDir, reviewed, cleanup: () => rm(workDir, { recursive: true, force: true }) };
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd });
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', message], { cwd });
}

async function failureOf(run: Promise<unknown>): Promise<NodeFailure> {
  const thrown: unknown = await run.then(() => undefined, (e: unknown) => e);
  assert.ok(thrown instanceof NodeFailure, `expected a NodeFailure, got: ${String(thrown)}`);
  return thrown;
}

const CODER = roleNamed('coder', { expectsChange: true });

test('a cli-tier coder that answers, exits 0 and changes nothing fails with no_change and the output tail', async () => {
  const adapter = new ScriptedCli();
  adapter.reply = { ...adapter.reply, output: `HEAD-OF-OUTPUT ${'x'.repeat(2_000)} permission to edit hello.txt was denied` };
  const fx = await makeFixture(CODER, adapter);
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.equal(failure.exitCode, 0);
    assert.match(failure.message, /role "coder" expects to change the tree/);
    assert.match(failure.message, /exit code 0/);
    assert.ok(failure.message.includes('permission to edit hello.txt was denied'), 'the tail says why');
    assert.ok(!failure.message.includes('HEAD-OF-OUTPUT'), 'only the tail');
    assert.deepEqual(fx.reviewed, [], 'an empty diff is not sent for review');
  } finally {
    await fx.cleanup();
  }
});

test('the same coder that changes a file succeeds, and its diff is reviewed once', async () => {
  const adapter = new ScriptedCli();
  adapter.reply = { ...adapter.reply, output: 'changed hello.txt' };
  const fx = await makeFixture(CODER, adapter);
  adapter.script.push(async () => { await writeFile(path.join(fx.workDir, 'hello.txt'), 'hello, changed', 'utf8'); });
  try {
    const out = await fx.dispatcher.runNode(nodeFor('coder'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'changed hello.txt' });
    assert.equal(fx.reviewed.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('a coder that commits its change is judged against the start commit, not HEAD', async () => {
  const adapter = new ScriptedCli();
  adapter.reply = { ...adapter.reply, output: 'committed the change' };
  const fx = await makeFixture(CODER, adapter);
  adapter.script.push(async () => {
    await writeFile(path.join(fx.workDir, 'hello.txt'), 'hello, committed', 'utf8');
    await commitAll(fx.workDir, 'agent committed');
  });
  try {
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(fx.reviewed.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('a retry is judged against the baseline its first attempt captured', async () => {
  const adapter = new ScriptedCli();
  adapter.reply = { ...adapter.reply, output: 'nothing left to change' };
  const fx = await makeFixture(CODER, adapter);
  adapter.script.push(
    async () => {
      await writeFile(path.join(fx.workDir, 'hello.txt'), 'hello, attempt 1', 'utf8');
      await commitAll(fx.workDir, 'attempt 1 committed');
      throw new TransportError('the backend closed the connection');
    },
    async () => {},
  );
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), TransportError);
    // A baseline re-captured for attempt 2 would contain attempt 1's commit, diff empty, and the
    // node would fail as no_change although the change it was asked for is in the tree.
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(fx.reviewed.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test('a tester that changes nothing succeeds: it does not expect a change', async () => {
  const tester = roleNamed('tester', { allowedTools: ['fs.read', 'patch.apply', 'test.run'].map(makeToolId) });
  const fx = await makeFixture(tester, new ScriptedCli());
  try {
    const out = await fx.dispatcher.runNode(nodeFor('tester'));
    assert.equal(out['output']?.kind, 'string');
  } finally {
    await fx.cleanup();
  }
});

test('a custom role with expectsChange: true is judged as the coder is', async () => {
  const bot = roleNamed('release-bot', { allowedTools: [makeToolId('git.commit')], expectsChange: true });
  const fx = await makeFixture(bot, new ScriptedCli());
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('release-bot')));
    assert.equal(failure.reason, 'no_change');
    assert.match(failure.message, /role "release-bot" expects to change the tree/);
  } finally {
    await fx.cleanup();
  }
});

test('no_change judges only an otherwise successful answer', async () => {
  const failedCall = new ScriptedCli();
  failedCall.reply = { success: false, output: 'Invalid API key', toolCallLog: [], exitCode: 1, duration: 1 };
  let fx = await makeFixture(CODER, failedCall);
  try {
    assert.equal((await failureOf(fx.dispatcher.runNode(nodeFor('coder')))).reason, 'adapter_failed');
  } finally {
    await fx.cleanup();
  }

  const silent = new ScriptedCli();
  silent.reply = { success: true, output: ' \n', toolCallLog: [], exitCode: 0, duration: 1 };
  fx = await makeFixture(CODER, silent);
  try {
    assert.equal((await failureOf(fx.dispatcher.runNode(nodeFor('coder')))).reason, 'empty_output');
  } finally {
    await fx.cleanup();
  }
});

// ─── the in-process tier (WP-2.18) ───────────────────────────────────────────
// A failed tool call is answered to the model rather than ending the node, so a coder whose every
// call failed can complete and say so. D-32 judges that answer as it judges a cli-tier one.

const IN_PROCESS_TAIL = 'I could not write the file, so hello.txt is unchanged.';

test('an in-process coder whose calls all fail, and that then answers in text, fails with no_change and the loop\'s last text', async () => {
  const fx = await makeFixture(CODER, new ScriptedTurns(failingCalls(), IN_PROCESS_TAIL));
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.equal(failure.exitCode, undefined, 'no process exited');
    assert.match(failure.message, /^role "coder" expects to change the tree, so its in-process loop on adapter "scripted-cli" was expected to leave a diff against the node's start commit [0-9a-f]{12}, but the loop completed and changed nothing/);
    assert.ok(failure.message.endsWith(`Output tail: ${JSON.stringify(IN_PROCESS_TAIL)}`), failure.message);
    assert.deepEqual(fx.reviewed, [], 'an empty diff is not sent for review');
  } finally {
    await fx.cleanup();
  }
});

test('an in-process coder that answers at once, calling no tool, fails with no_change too', async () => {
  const fx = await makeFixture(CODER, new ScriptedTurns());
  try {
    assert.equal((await failureOf(fx.dispatcher.runNode(nodeFor('coder')))).reason, 'no_change');
  } finally {
    await fx.cleanup();
  }
});

test('the same in-process coder with one successful write succeeds, and its diff is reviewed once', async () => {
  const turns = [...failingCalls(), calling('fs.write', { path: 'hello.txt', content: 'hello, changed' }, 4)];
  const fx = await makeFixture(CODER, new ScriptedTurns(turns, 'changed hello.txt'));
  try {
    const out = await fx.dispatcher.runNode(nodeFor('coder'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'changed hello.txt' });
    assert.equal(fx.reviewed.length, 1);
    assert.match(fx.reviewed[0] ?? '', /\+hello, changed/);
  } finally {
    await fx.cleanup();
  }
});

test('an in-process tester that changes nothing succeeds: it does not expect a change', async () => {
  const tester = roleNamed('tester', { allowedTools: ['fs.read', 'patch.apply', 'test.run'].map(makeToolId) });
  const fx = await makeFixture(tester, new ScriptedTurns([calling('fs.read', { path: 'missing.txt' }, 1)], 'no test to add'));
  try {
    const out = await fx.dispatcher.runNode(nodeFor('tester'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'no test to add' });
  } finally {
    await fx.cleanup();
  }
});

test('an in-process loop that stops any other way keeps its own failure, not no_change', async () => {
  // Out of turns before it answers: budget_exhausted, which a node may accept with allowPartial.
  const coder = roleNamed('coder', { expectsChange: true, maxToolIterations: 2 });
  const fx = await makeFixture(coder, new ScriptedTurns(failingCalls()));
  try {
    assert.equal((await failureOf(fx.dispatcher.runNode(nodeFor('coder')))).reason, 'budget_exhausted');
  } finally {
    await fx.cleanup();
  }
});

// ─── F10: a no_change message names the rules that denied the node's own calls ───────────────
// A writer that changed nothing reads the same whether it lost its nerve or its one write was
// refused by policy. A denied call is answered to the in-process loop as a failed result (WP-2.18),
// so the node can still complete and reach no_change — and the attestor is the only place the rule
// id lives, because the tool message the model saw carries none.

test('F10: an in-process coder whose write the policy denied fails with no_change, naming the rule', async () => {
  const attestor = new RecordingAttestor();
  const turns = [calling('fs.write', { path: 'hello.txt', content: 'hi' }, 1)];
  const fx = await makeFixture(CODER, new ScriptedTurns(turns, 'I was not permitted to write.'), {
    attestor: attestor as unknown as Attestor,
    policy: denyingPolicy('fs.write', 'protect-secrets'),
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.match(failure.message, /; 1 tool call was denied or refused by policy: protect-secrets \(fs\.write\)$/);
    // The rule id is not in the tool message the model saw, so the message is the attestor's alone.
    assert.equal(attestor.calls.length, 1, 'the refused call was attested');
    assert.equal(attestor.calls[0]?.policyDecision.verdict, 'Deny');
  } finally {
    await fx.cleanup();
  }
});

test('F10: at most three rules are named; the count carries the rest', async () => {
  const attestor = new RecordingAttestor();
  const turns = Array.from({ length: 4 }, (_, i) => calling('fs.write', { path: `f${i}.txt`, content: 'x' }, i + 1));
  const fx = await makeFixture(CODER, new ScriptedTurns(turns, 'no write was permitted.'), {
    attestor: attestor as unknown as Attestor,
    policy: denyingPolicy('fs.write', 'deny-all-writes'),
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.match(
      failure.message,
      /; 4 tool calls were denied or refused by policy: deny-all-writes \(fs\.write\), deny-all-writes \(fs\.write\), deny-all-writes \(fs\.write\), …$/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('F10: a coder that made no denied call leaves the no_change message as it was', async () => {
  const attestor = new RecordingAttestor();
  // An allow policy: the one write fails for a reason of its own (no such directory), not a Deny.
  const fx = await makeFixture(CODER, new ScriptedTurns(failingCalls(), 'I could not write.'), {
    attestor: attestor as unknown as Attestor,
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.ok(!failure.message.includes('by policy'), failure.message);
    assert.ok(failure.message.endsWith(`Output tail: ${JSON.stringify('I could not write.')}`), failure.message);
  } finally {
    await fx.cleanup();
  }
});

test('F10/F4: the deny clause is per node — a sibling\'s denied call is not this node\'s failure', async () => {
  // One attestor, two nodes of the same coder role, the adapter's one scripted call belonging to the
  // first. n1's write is denied (`deny-env-files`); n2, whose turns are already spent, makes no call.
  // The attestor holds n1's denial for the whole run, so a run-wide count would put the clause on
  // n2's message too — and two nodes would read identically although only one was refused. The
  // clause is read back by this node's own taskId.
  const attestor = new RecordingAttestor();
  const turns = [calling('fs.write', { path: '.env', content: 'SECRET=1' }, 1)];
  const fx = await makeFixture(CODER, new ScriptedTurns(turns, 'I made no write.'), {
    attestor: attestor as unknown as Attestor,
    policy: denyingPolicy('fs.write', 'deny-env-files'),
  });
  try {
    const n1 = await failureOf(fx.dispatcher.runNode(nodeFor('coder', 'n1')));
    assert.equal(n1.reason, 'no_change');
    assert.match(n1.message, /; 1 tool call was denied or refused by policy: deny-env-files \(fs\.write\)$/);

    // n2 makes no call, so its own record set for its taskId is empty, and the message is unchanged.
    const n2 = await failureOf(fx.dispatcher.runNode(nodeFor('coder', 'n2')));
    assert.equal(n2.reason, 'no_change');
    assert.ok(!n2.message.includes('by policy'), `n2 made no denied call of its own:\n${n2.message}`);

    // The attestor held a denial the whole time — so the absence above is the per-task filter, not
    // an empty attestor.
    assert.equal(attestor.calls.length, 1, 'n1\'s denial is on the record while n2 runs');
    assert.equal(attestor.toolCallsForTask(makeTaskId('n2')).length, 0, 'and it is not n2\'s');
  } finally {
    await fx.cleanup();
  }
});

// ─── F8: the count is of every refusal, not just a policy Deny ────────────────────────────────
// The clause's count came from a `Deny`-verdict filter, so the refusals that are not a `Deny` were
// invisible: an `Escalate` the gate did not approve, and an `Indeterminate`. Each leaves the tree
// unchanged exactly as a `Deny` does, so each belongs in the count. The clause now reads "denied or
// refused by policy", the count comes from the `metadata.refused` marker `executeToolGated` sets on
// every call that did not run, and the rule is read from whichever field the decision carries it on.

test('F8: an Escalate the gate did not approve is refused, and is named by its policy rule', async () => {
  const attestor = new RecordingAttestor();
  const turns = [calling('fs.write', { path: 'hello.txt', content: 'hi' }, 1)];
  // No `approvalGate` on the dispatcher, so the request is refused outright. The rule id lives on the
  // request the gate would have been shown, not on the decision's own top level — the `Deny`-only
  // filter both missed the call and would have had no id to name it by.
  const escalating = {
    evaluate: async (id: unknown): Promise<PolicyDecision> =>
      String(id) === 'fs.write'
        ? {
            verdict: 'Escalate',
            reason: 'writes are escalated',
            approvalRequest: {
              id: 'req-1', runId: makeRunId('run-no-change'), taskId: makeTaskId('coder-1'),
              requestedBy: makeAgentId('a1'), toolId: makeToolId('fs.write'),
              policyRuleId: 'escalate-writes', description: 'review the write', createdAt: new Date(0),
            },
          }
        : { verdict: 'Allow' },
  } as unknown as PolicyEngine;
  const fx = await makeFixture(CODER, new ScriptedTurns(turns, 'I asked first.'), {
    attestor: attestor as unknown as Attestor,
    policy: escalating,
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.match(failure.message, /; 1 tool call was denied or refused by policy: escalate-writes \(fs\.write\)$/);
    assert.equal(attestor.calls[0]?.policyDecision.verdict, 'Escalate', 'a refusal the Deny-only filter missed');
  } finally {
    await fx.cleanup();
  }
});

test('F8: a refusal whose decision records no rule id is still counted, and named as such', async () => {
  const attestor = new RecordingAttestor();
  const turns = [calling('fs.write', { path: 'hello.txt', content: 'hi' }, 1)];
  const nameless = {
    evaluate: async (id: unknown): Promise<PolicyDecision> =>
      String(id) === 'fs.write' ? { verdict: 'Deny', reason: 'forbidden' } : { verdict: 'Allow' },
  } as unknown as PolicyEngine;
  const fx = await makeFixture(CODER, new ScriptedTurns(turns, 'no write.'), {
    attestor: attestor as unknown as Attestor,
    policy: nameless,
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.match(
      failure.message,
      /; 1 tool call was denied or refused by policy: a rule that recorded no id \(fs\.write\)$/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── where the expectation is declared ───────────────────────────────────────

test('the built-in coder is the only built-in role that expects a change', () => {
  const expecting = DEFAULT_ROLE_SET.roles.filter((r) => r.expectsChange === true).map((r) => r.role);
  assert.deepEqual(expecting, ['coder']);
});

test('the shipped .maf/roles.yaml declares the same: only coder expects a change', async () => {
  // dist/__tests__ → the repository root, where this package's own roles file lives.
  const mafDir = path.resolve(__dirname, '../../../../.maf');
  const roles = await RoleRegistry.fromYamlOrDefault(path.join(mafDir, 'roles.yaml'), mafDir, createDefaultRegistry());
  const expecting = roles.list().filter((r) => r.expectsChange === true).map((r) => r.role);
  assert.deepEqual(expecting, ['coder']);
  assert.ok(roles.list().some((r) => r.role === 'tester'), 'the file that was read is the full role set');
});

test('a role with no write tool may not set expectsChange', () => {
  assert.throws(
    () => RoleRegistry.fromSet({
      version: 1, defaultRole: defineRoleName('reviewer'),
      roles: [{ role: defineRoleName('reviewer'), systemPrompt: 'x', allowedTools: [makeToolId('fs.read')], expectsChange: true }],
    }, '/tmp/maf-no-change'),
    (err: unknown) => err instanceof RoleConfigError && /"reviewer" sets expectsChange: true.*holds none/.test(err.message),
  );
  // And a role holding test.run alone may set it: test.run is a write tool to isWriterRole (F10), and
  // the message names it among them.
  RoleRegistry.fromSet({
    version: 1, defaultRole: defineRoleName('tester'),
    roles: [{ role: defineRoleName('tester'), systemPrompt: 'x', allowedTools: [makeToolId('test.run')], expectsChange: true }],
  }, '/tmp/maf-no-change');
  assert.throws(
    () => RoleRegistry.fromSet({
      version: 1, defaultRole: defineRoleName('reviewer'),
      roles: [{ role: defineRoleName('reviewer'), systemPrompt: 'x', allowedTools: [makeToolId('grep')], expectsChange: true }],
    }, '/tmp/maf-no-change'),
    /\(fs\.write, fs\.delete, patch\.apply, git\.add, git\.commit, git\.reset or test\.run\)/,
  );
});

test('roles.yaml: a non-boolean expectsChange is refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-yaml-'));
  try {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, JSON.stringify({
      version: 1, defaultRole: 'coder',
      roles: [{ role: 'coder', systemPrompt: 'x', allowedTools: ['fs.write'], expectsChange: 'yes' }],
    }), 'utf8');
    await assert.rejects(RoleRegistry.fromYamlOrDefault(file, dir, createDefaultRegistry()), RoleConfigError);
    assert.match(await readFile(file, 'utf8'), /"yes"/, 'the file the registry refused is the one written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a harness role carries expectsChange into the role set it dispatches', () => {
  const set = roleSetFromHarness({
    version: 1, defaultRole: 'coder',
    roles: [{ role: 'coder', allowedTools: ['fs.write'], expectsChange: true }, { role: 'tester', allowedTools: ['patch.apply'] }],
  });
  assert.equal(set.roles[0]?.expectsChange, true);
  assert.equal('expectsChange' in (set.roles[1] ?? {}), false, 'absent stays absent');
});

test('a harness role whose expectsChange is not a boolean is refused at the boundary', () => {
  // What a hand-edited harness file can carry; the type says boolean, the file need not.
  const parsed = JSON.parse('{"role":"coder","allowedTools":["fs.write"],"expectsChange":"yes"}') as HarnessRoleConfig;
  assert.throws(
    () => roleSetFromHarness({ version: 1, defaultRole: 'coder', roles: [parsed] }),
    (err: unknown) => err instanceof HarnessConfigError && /expectsChange must be a boolean, got "yes"/.test(err.message),
  );
});
