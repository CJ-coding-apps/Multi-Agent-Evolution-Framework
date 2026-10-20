import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeResult, AssistantTurn, DagNode,
  ToolCallRecord, TaskId, PolicyDecision, ApprovalAsk, ApprovalOutcome, ApprovalGateHandle,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, makeTaskId, makeAgentId, NodeFailure, TransportError } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { SecurityReviewGate } from '@maf/git-ops';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';
import type { RoleConfig } from '../RoleConfig.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';
import { isWriterRole, expectsToolCalls } from '../isWriterRole.js';
import { roleSetFromHarness } from '../harnessBridge.js';

// ORACLE: D-46(ii) (WP-3.1), generalised by the 0.4.0 audit (A2) — a verdict is read from the record,
// not the narrative. Live row 2b of the 3.0c pass: an in-process `analyst` ran with the host's native
// tools disabled (`--tools ''`), tried Read/Glob/Grep anyway, was refused ("No such tool available"),
// gave up — and MAF read `Succeeded` off the prose. The record said what happened: zero calls, one
// turn, a refusal. A role that was **not expected to change the tree** (`expectsChange` is not `true`)
// and finishes with a final answer after making no executed tool call fails `no_work`; a role that
// does expect a change (`expectsChange: true`, the built-in `coder`) is judged by `no_change` (D-32),
// never `no_work`. The predicate is `expectsChange`, not "holds a write tool": the built-in `tester`
// holds `test.run` yet expects no change, so it is judged here (A2). `Allow` is a call that ran — a
// call the policy refused left the tree exactly as it found it, so it is no work.

const execFileAsync = promisify(execFile);

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

/** A cli-tier backend whose every call is scripted, and is also a TurnAdapter (the loop half). */
class ScriptedTurns implements TurnAdapter {
  readonly name = 'scripted-cli';
  constructor(private readonly turns: AssistantTurn[] = [], private readonly final = 'nothing to do') {}
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: true }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    return { success: true, toolCallLog: [], exitCode: 0, duration: 1, output: this.final };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(): Promise<AssistantTurn> { return this.turns.shift() ?? { text: this.final, toolCalls: [] }; }
}

/** One turn making one tool call. */
function calling(toolName: string, input: Record<string, unknown>, n: number): AssistantTurn {
  return { text: `call ${n}`, toolCalls: [{ toolUseId: `u${n}`, toolName, input }] };
}

/**
 * An attestor that keeps every call it was handed. `executeToolGated` records both an executed call
 * (verdict `Allow`) and a refused one (its verdict plus `metadata.refused`) through the same
 * `record`, and `toolCallsForTask` reads them back per task — which is what `no_work` counts.
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

/** A policy engine that escalates one tool by a named rule and allows every other call. */
function escalatingPolicy(toolId: string, ruleId: string): PolicyEngine {
  return {
    evaluate: async (id: unknown): Promise<PolicyDecision> =>
      String(id) === toolId
        ? {
            verdict: 'Escalate',
            reason: 'this call needs approval',
            approvalRequest: {
              id: 'req-1', runId: makeRunId('run-no-work'), taskId: makeTaskId('analyst-1'),
              requestedBy: makeAgentId('a1'), toolId: makeToolId(toolId),
              policyRuleId: ruleId, description: 'approve this call', createdAt: new Date(0),
            },
          }
        : { verdict: 'Allow' },
  } as unknown as PolicyEngine;
}

/** An approval gate that approves every request, echoing its own id (F4: an approved Escalate ran). */
const APPROVING_GATE: ApprovalGateHandle = {
  decide: async (ask: ApprovalAsk): Promise<ApprovalOutcome> => ({
    approved: true, status: 'Approved', requestId: ask.request.id, requestHash: 'hash', reason: 'approved by test gate',
  }),
};

const READ_TOOLS = ['fs.read', 'fs.list', 'fs.stat', 'grep', 'git.diff', 'git.log'];

/** A role, read-only by default, on the in-process tier so the loop's turn count is real. */
function readerRole(name: string, extra: Partial<RoleConfig> = {}): RoleConfig {
  return {
    role: defineRoleName(name), systemPrompt: 'read',
    allowedTools: READ_TOOLS.map(makeToolId), execution: 'in-process', ...extra,
  };
}

function writerRole(name: string, extra: Partial<RoleConfig> = {}): RoleConfig {
  return {
    role: defineRoleName(name), systemPrompt: 'work',
    allowedTools: ['fs.read', 'fs.write', 'git.commit'].map(makeToolId), ...extra,
  };
}

function nodeFor(name: string, id = `${name}-1`): DagNode {
  return {
    id: makeNodeId(id), label: 'answer the question', agentRole: defineRoleName(name), dependencies: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {}, metadata: { taskDescription: 'answer the question' },
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
  deps: { policy?: PolicyEngine; attestor?: Attestor; approvalGate?: ApprovalGateHandle } = {},
): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-no-work-'));
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
    ...(deps.approvalGate ? { approvalGate: deps.approvalGate } : {}),
    attestor: deps.attestor ?? { record: async () => {}, recordSecurityFindings: () => {} } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: { append: async () => {} } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    securityGate: {
      reviewDiff: async (diff: string) => { reviewed.push(diff); return { findings: [], summary: 'clean', passed: true }; },
    } as unknown as SecurityReviewGate,
    cwd: workDir,
    sessionId: 's1',
    runId: makeRunId('run-no-work'),
    harness: { processorBundles: [] } as unknown as HarnessConfig,
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

// ─── a reader that did no work has not succeeded ──────────────────────────────

test('an in-process reader that answers, calling no tool, fails with no_work naming the role, zero, the turn count and the answer', async () => {
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(readerRole('analyst'), new ScriptedTurns([], 'Everything is fine.'), {
    attestor: attestor as unknown as Attestor,
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    assert.equal(failure.exitCode, undefined, 'no process exited');
    assert.match(
      failure.message,
      /^role "analyst" made no executed tool call across 1 turn; its answer: "Everything is fine\."$/,
    );
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1')).length, 0, 'the record says it made no call');
  } finally {
    await fx.cleanup();
  }
});

test('the no_work message collapses whitespace and keeps only the first 200 characters of the answer (F7)', async () => {
  // F7: the `\n` and the `\t` sit *inside* the first 200 characters, so a message that carried the
  // raw answer would still show them. The old fixture put the newline past the cut, where the slice
  // alone removed it — the collapse could have been deleted and the test still passed. Here the two
  // assertions below fail if the collapse is removed (kills M5).
  const answer = `read the file.\n\tand then stopped.  ${'a'.repeat(250)}`;
  const fx = await makeFixture(readerRole('analyst'), new ScriptedTurns([], answer));
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    // The message stays one line: no raw newline or tab survives anywhere in it.
    assert.ok(!failure.message.includes('\n'), 'the message is a single line');
    assert.ok(!failure.message.includes('\t'), 'and carries no raw tab');
    const quoted = failure.message.slice(failure.message.indexOf('its answer: ') + 'its answer: '.length);
    const excerpt = JSON.parse(quoted) as string;
    assert.equal(excerpt.length, 200, 'exactly the first 200 characters');
    assert.ok(!excerpt.includes('\n') && !excerpt.includes('\t'), 'the excerpt itself has no whitespace runs');
    assert.match(excerpt, /^read the file\. and then stopped\. a+$/, 'every whitespace run collapsed to one space');
  } finally {
    await fx.cleanup();
  }
});

test('the same reader that makes one executed call succeeds: a reader that reads is not penalised', async () => {
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(readerRole('analyst'), new ScriptedTurns([calling('fs.read', { path: 'hello.txt' }, 1)], 'hello.txt holds "hello".'), {
    attestor: attestor as unknown as Attestor,
  });
  try {
    const out = await fx.dispatcher.runNode(nodeFor('analyst'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'hello.txt holds "hello".' });
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1'))[0]?.policyDecision.verdict, 'Allow');
  } finally {
    await fx.cleanup();
  }
});

test('a reader whose only call was denied fails no_work, with the F10 clause naming the rule that refused it', async () => {
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(readerRole('analyst'), new ScriptedTurns([calling('fs.read', { path: 'hello.txt' }, 1)], 'I was not permitted to read.'), {
    attestor: attestor as unknown as Attestor,
    policy: denyingPolicy('fs.read', 'deny-reads'),
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    // The denied call is on the record, but a refused call is no work — it never ran.
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1')).length, 1);
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1'))[0]?.policyDecision.verdict, 'Deny');
    assert.match(failure.message, /^role "analyst" made no executed tool call across 2 turns; its answer: "I was not permitted to read\."/);
    assert.match(failure.message, /; 1 tool call was denied or refused by policy: deny-reads \(fs\.read\)$/);
    // F5: the same rule and tool the clause names are on the failure as values, so a machine reads
    // the dispatcher's own refusal off the failure rather than grepping the prose.
    assert.equal(failure.ruleId, 'deny-reads');
    assert.equal(failure.toolId, 'fs.read');
  } finally {
    await fx.cleanup();
  }
});

test('a reader whose every call is counted — a call that ran and failed included — is not no_work', async () => {
  // `executeToolGated` answers a tool that fails while running with a failed result recorded under
  // the `Allow` that let it run. That is work: the model called a tool, it was permitted, it ran.
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(readerRole('analyst'), new ScriptedTurns([calling('fs.read', { path: 'missing.txt' }, 1)], 'That file is not there.'), {
    attestor: attestor as unknown as Attestor,
  });
  try {
    const out = await fx.dispatcher.runNode(nodeFor('analyst'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'That file is not there.' });
    const [call] = attestor.toolCallsForTask(makeTaskId('analyst-1'));
    assert.equal(call?.policyDecision.verdict, 'Allow');
    assert.equal(call?.result.exitCode, 1, 'the call ran and failed — still not no_work');
  } finally {
    await fx.cleanup();
  }
});

// ─── the opt-out, and the two defaults ─────────────────────────────────────────

test('a read-only role may opt out with expectsToolCalls: false and succeeds with zero calls', async () => {
  const fx = await makeFixture(
    readerRole('greeter', { expectsToolCalls: false }),
    new ScriptedTurns([], 'Hello from the prompt alone.'),
  );
  try {
    const out = await fx.dispatcher.runNode(nodeFor('greeter'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'Hello from the prompt alone.' });
  } finally {
    await fx.cleanup();
  }
});

test('a role that holds no tool at all defaults to no expectation and succeeds with zero calls', async () => {
  const empty = readerRole('echo', { allowedTools: [] });
  const fx = await makeFixture(empty, new ScriptedTurns([], 'Answered from the prompt.'));
  try {
    const out = await fx.dispatcher.runNode(nodeFor('echo'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'Answered from the prompt.' });
  } finally {
    await fx.cleanup();
  }
});

test('expectsToolCalls: the declaration is read when present, the tools otherwise', () => {
  const withTools = readerRole('analyst');
  const noTools = readerRole('echo', { allowedTools: [] });
  assert.equal(expectsToolCalls(withTools), true, 'a reader with tools is expected to call one');
  assert.equal(expectsToolCalls(noTools), false, 'a role with nothing to call expects nothing');
  assert.equal(expectsToolCalls({ ...withTools, expectsToolCalls: false }), false, 'the opt-out wins');
  assert.equal(expectsToolCalls({ ...noTools, expectsToolCalls: true }), true, 'an explicit yes wins too');
});

// ─── the boundary: a writer's zero-call answer is no_change, never no_work ─────

test('a writer with zero calls fails no_change, never no_work', async () => {
  const fx = await makeFixture(writerRole('coder', { expectsChange: true }), new ScriptedTurns([], 'I changed nothing.'));
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.notEqual(failure.reason, 'no_work');
  } finally {
    await fx.cleanup();
  }
});

test('a role named coder that holds read-only tools is judged by its tools: no_work, not no_change', async () => {
  // The name is not consulted (D-07): a read-only `coder` is a reader, so a zero-call answer is
  // no_work. It cannot be no_change — that requires `expectsChange`, which needs a write tool.
  const fx = await makeFixture(readerRole('coder'), new ScriptedTurns([], 'I read nothing.'));
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_work');
    assert.equal(isWriterRole(readerRole('coder')), false, 'the fixture really holds no write tool');
  } finally {
    await fx.cleanup();
  }
});

test('a role named analyst that holds fs.write is a writer: no_change, never no_work', async () => {
  const fx = await makeFixture(
    writerRole('analyst', { expectsChange: true }),
    new ScriptedTurns([], 'I changed nothing.'),
  );
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_change');
    assert.equal(isWriterRole(writerRole('analyst')), true, 'the fixture really holds a write tool');
  } finally {
    await fx.cleanup();
  }
});

// ─── A2 (0.4.0 audit): the guard is `expectsChange`, not "holds a write tool" — the tester ─────

test('A2: the built-in tester that answers with no tool call fails no_work', async () => {
  // The tester holds `test.run` (a write tool, so a writer for the gate) but declares no
  // `expectsChange`: its job is to run the tests, not to change the code. The old `isWriterRole` test
  // excused it, so "All tests pass." on turn one succeeded — the exact shape no_work exists to catch.
  const tester = DEFAULT_ROLE_SET.roles.find((r) => r.role === 'tester');
  assert.ok(tester, 'the built-in tester exists');
  assert.equal(isWriterRole(tester), true, 'the tester holds test.run, so it is a writer for the gate');
  assert.equal(tester.expectsChange, undefined, 'and it declares no expectsChange');
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(tester, new ScriptedTurns([], 'All tests pass.'), {
    attestor: attestor as unknown as Attestor,
  });
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('tester')));
    assert.equal(failure.reason, 'no_work');
    assert.match(
      failure.message,
      /^role "tester" made no executed tool call across 1 turn; its answer: "All tests pass\."$/,
    );
    assert.equal(attestor.toolCallsForTask(makeTaskId('tester-1')).length, 0, 'the record says it made no call');
  } finally {
    await fx.cleanup();
  }
});

test('A2: a tester that runs the tests succeeds — the guard is "made no call", not "made no change"', async () => {
  const tester = DEFAULT_ROLE_SET.roles.find((r) => r.role === 'tester');
  assert.ok(tester);
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(tester, new ScriptedTurns([calling('test.run', { runner: 'node' }, 1)], 'All tests pass.'), {
    attestor: attestor as unknown as Attestor,
  });
  try {
    const out = await fx.dispatcher.runNode(nodeFor('tester'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'All tests pass.' });
    assert.equal(attestor.toolCallsForTask(makeTaskId('tester-1'))[0]?.policyDecision.verdict, 'Allow');
  } finally {
    await fx.cleanup();
  }
});

test('A2: the tester may opt out with expectsToolCalls: false and succeeds with zero calls', async () => {
  const tester = DEFAULT_ROLE_SET.roles.find((r) => r.role === 'tester');
  assert.ok(tester);
  const optedOut: RoleConfig = { ...tester, expectsToolCalls: false };
  const fx = await makeFixture(optedOut, new ScriptedTurns([], 'Nothing to test.'));
  try {
    const out = await fx.dispatcher.runNode(nodeFor('tester'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'Nothing to test.' });
  } finally {
    await fx.cleanup();
  }
});

test('A2: a role that expects a change is still judged by no_change, never no_work — even holding a write tool', async () => {
  // The generalisation must not swallow the writer: `expectsChange: true` (the built-in coder) stays
  // under no_change, and no_work is the complement, not an addition.
  const fx = await makeFixture(writerRole('coder', { expectsChange: true }), new ScriptedTurns([], 'I changed nothing.'));
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('coder')));
    assert.equal(failure.reason, 'no_change');
    assert.notEqual(failure.reason, 'no_work');
  } finally {
    await fx.cleanup();
  }
});

// ─── a cli-tier reader is untouched: MAF attests no per-call record there ─────

test('a cli-tier reader with zero calls is not judged no_work: the check is in-process only', async () => {
  // On the cli tier MAF hands the backend one prompt and reads back one opaque result; it records no
  // per-call ToolCallRecord, so an empty call set there means "unwatched", not "did no work".
  // Live row 1 of the 3.0c pass is exactly this shape and must Succeed.
  const cliReader: RoleConfig = {
    role: defineRoleName('cli-auditor'), systemPrompt: 'read',
    allowedTools: READ_TOOLS.map(makeToolId), execution: 'cli',
  };
  const fx = await makeFixture(cliReader, new ScriptedTurns([], 'The audit found nothing.'));
  try {
    const out = await fx.dispatcher.runNode(nodeFor('cli-auditor'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'The audit found nothing.' });
  } finally {
    await fx.cleanup();
  }
});

// ─── the built-ins carry no expectation change, so a reader's no_work is the default ──────────

test('every built-in reader holds tools and none opts out, so each expects a tool call', () => {
  for (const name of ['security', 'reviewer', 'analyst']) {
    const role = DEFAULT_ROLE_SET.roles.find((r) => r.role === name);
    assert.ok(role, `built-in reader "${name}" exists`);
    assert.equal(isWriterRole(role), false, `${name} is a reader`);
    assert.equal(expectsToolCalls(role), true, `${name} is expected to call a tool`);
    assert.equal(role.expectsToolCalls, undefined, `${name} declares nothing — the default applies`);
  }
});

// ─── the harness carries the declaration both ways (F2: edit both directions) ────────────────

test('a harness role carries expectsToolCalls into the role set it dispatches', () => {
  const set = roleSetFromHarness({
    version: 1, defaultRole: 'analyst',
    roles: [{ role: 'analyst', allowedTools: ['fs.read'], expectsToolCalls: false }, { role: 'coder', allowedTools: ['fs.write'] }],
  });
  assert.equal(set.roles[0]?.expectsToolCalls, false);
  assert.equal('expectsToolCalls' in (set.roles[1] ?? {}), false, 'absent stays absent');
});

// ─── F1: the answer quoted by no_work is masked before it is stored ───────────
// The `no_work` message is not only the transcript: it is written into the signed bundle, the memory
// graph and the planner's `<past-failures>`, none of which the transcript scrubber sees. `outputTail`
// on the `no_change` path masks credentials; `answerExcerpt` must too, and before the cut.

test('F1: a credential in the reader\'s answer is masked in the no_work message, and the raw key is nowhere', async () => {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const fx = await makeFixture(
    readerRole('analyst'),
    new ScriptedTurns([], `I found the AWS key ${key} in config.ts, so I stopped.`),
  );
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    assert.match(failure.message, /\[REDACTED:aws-access-key\]/, 'the credential is masked, as the no_change tail is');
    assert.ok(!failure.message.includes(key), 'the raw key is nowhere in the message');
    // The mask stands where the key did, and the surrounding answer is still quoted.
    assert.match(
      failure.message,
      /its answer: "I found the AWS key \[REDACTED:aws-access-key\] in config\.ts, so I stopped\."$/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('F1: the mask is applied before the 200-character cut, so a key straddling it is still masked', async () => {
  // The order is load-bearing. `answerExcerpt` masks, then collapses, then cuts to 200. Reverse it
  // and the cut splits a key at character 200 into a fragment no format pattern recognises — the
  // fragment survives unmasked. Here the key begins at character 191 (the pattern needs a boundary
  // before `AKIA`, so a space, not an `x`, precedes it) and runs to 210, well past the cut.
  //
  // Note the mask is *longer* than the key (25 chars vs 20), so no placement lets both a straddling
  // key and the full `[REDACTED:aws-access-key]` token survive a 200-char cut. The observable that
  // distinguishes the two orders is therefore that the mask's *opening* is present — proof it was
  // inserted before the cut — and that no `AKIA` fragment is.
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const fx = await makeFixture(
    readerRole('analyst'),
    new ScriptedTurns([], `${'x'.repeat(190)} ${key} trailing text`),
  );
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.ok(
      failure.message.includes('[REDACTED'),
      'the mask is inserted before the cut, so its opening survives — slice-then-mask would show no mask at all',
    );
    assert.ok(!failure.message.includes('AKIA'), 'no fragment of the key survives the cut (mask-then-slice, not slice-then-mask)');
  } finally {
    await fx.cleanup();
  }
});

// ─── F3/A4: the executed count is this attempt's, not the node's ──────────────

/** A TurnAdapter whose scripted turns may include an Error to throw, so a transport failure is real. */
class ThrowingTurns implements TurnAdapter {
  readonly name = 'throwing-cli';
  constructor(private readonly script: Array<AssistantTurn | Error>, private readonly final = 'nothing to do') {}
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: true }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    return { success: true, toolCallLog: [], exitCode: 0, duration: 1, output: this.final };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(): Promise<AssistantTurn> {
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? { text: this.final, toolCalls: [] };
  }
}

test('F3/A4: a reader that read on an earlier attempt and not on this one fails no_work — the count is per attempt', async () => {
  // Attempt 1 reads hello.txt once, then its second model call fails with a transport error and the
  // node is retried. Attempt 2 answers without reading. The node's total executed count is 1 — a
  // count over the whole node would excuse attempt 2 and report Succeeded, which is L2 surviving on
  // the retry path. The guard reads the delta since the attempt began: attempt 2 read nothing.
  const attestor = new RecordingAttestor();
  const adapter = new ThrowingTurns(
    [calling('fs.read', { path: 'hello.txt' }, 1), new TransportError('the backend closed the connection')],
    'I did not read this time.',
  );
  const fx = await makeFixture(readerRole('analyst'), adapter, { attestor: attestor as unknown as Attestor });
  try {
    // Attempt 1: the read runs, then the transport fails, and the node is retryable.
    await assert.rejects(fx.dispatcher.runNode(nodeFor('analyst')), TransportError);
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1')).length, 1, 'attempt 1 read once');

    // Attempt 2: no executed call. The node has one executed call in total, but none this attempt.
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1')).length, 1, 'still only attempt 1\'s read is on the record');
  } finally {
    await fx.cleanup();
  }
});

// ─── F4/A2: "executed" is "not refused" — an approved Escalate ran, a refused one did not ──────

test('F4/A2: an approved Escalate ran, so a reader whose only call was one has done its work', async () => {
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(
    readerRole('analyst'),
    new ScriptedTurns([calling('fs.read', { path: 'hello.txt' }, 1)], 'hello.txt holds "hello".'),
    { attestor: attestor as unknown as Attestor, policy: escalatingPolicy('fs.read', 'escalate-reads'), approvalGate: APPROVING_GATE },
  );
  try {
    const out = await fx.dispatcher.runNode(nodeFor('analyst'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'hello.txt holds "hello".' });
    const [call] = attestor.toolCallsForTask(makeTaskId('analyst-1'));
    assert.equal(call?.policyDecision.verdict, 'Escalate', 'the call carried an Escalate verdict');
    assert.notEqual(call?.result.metadata.refused, true, 'and it ran: the gate approved it, so no refused mark');
  } finally {
    await fx.cleanup();
  }
});

test('F4/A2: an Escalate the gate refused left the tree as it found it — not work, so the reader fails no_work', async () => {
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(
    readerRole('analyst'),
    new ScriptedTurns([calling('fs.read', { path: 'hello.txt' }, 1)], 'I asked first and was refused.'),
    { attestor: attestor as unknown as Attestor, policy: escalatingPolicy('fs.read', 'escalate-reads') },
  );
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    assert.match(failure.message, /; 1 tool call was denied or refused by policy: escalate-reads \(fs\.read\)$/);
    assert.equal(failure.ruleId, 'escalate-reads', 'the rule the escalation named is on the failure');
    assert.equal(failure.toolId, 'fs.read');
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1'))[0]?.result.metadata.refused, true);
  } finally {
    await fx.cleanup();
  }
});

test('F4: a malformed call (builtin:input-schema) is not work: the reader still made no executed call', async () => {
  // `fs.read` with no `path`: the tool's schema refuses it before policy is asked. The call is in the
  // record — `Indeterminate`, `builtin:input-schema`, `refused` — but nothing ran, so it is no work.
  const attestor = new RecordingAttestor();
  const fx = await makeFixture(
    readerRole('analyst'),
    new ScriptedTurns([calling('fs.read', {}, 1)], 'my call was rejected.'),
    { attestor: attestor as unknown as Attestor },
  );
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    assert.equal(failure.toolId, undefined, 'a builtin refusal names no policy rule or tool');
    assert.equal(failure.ruleId, undefined);
    assert.ok(!failure.message.includes('by policy'), 'and the clause does not name a builtin refusal');
    const [call] = attestor.toolCallsForTask(makeTaskId('analyst-1'));
    assert.equal(call?.result.metadata.refused, true);
    assert.equal(
      (call?.policyDecision as { ruleId?: string }).ruleId, 'builtin:input-schema',
      'the record names the schema as the rule that refused the malformed call',
    );
  } finally {
    await fx.cleanup();
  }
});
