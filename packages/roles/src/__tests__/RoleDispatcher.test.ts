import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult,
  TurnMessage, AssistantTurn, DagNode, PolicyDecision, ToolContext, ToolInput, ToolResult,
  RoleName, PartialNodeOutcome, ExecutionTierRecord,
} from '@maf/types';
import { makeNodeId, makeRunId, makeTaskId, makeAgentId, makeToolId, NodeFailure, TransportError } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { defineRoleName } from '../RoleConfig.js';
import { RoleRegistry } from '../RoleRegistry.js';

// ORACLE: RoleDispatcher — in-process dispatch, fallback, gating parity.

// ─── stubs (shell-seam doubles; core under test is RoleDispatcher) ───────────

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

class StubTurnAdapter implements TurnAdapter {
  readonly name = 'stub';
  invoked = 0;
  turnsToServe: AssistantTurn[] = [];
  histories: TurnMessage[][] = [];
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    this.invoked++;
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(history: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    this.histories.push(history);
    const next = this.turnsToServe.shift();
    if (!next) return { text: 'final', toolCalls: [] };
    return next;
  }
}

class CliOnlyAdapter implements CliAdapter {
  readonly name = 'cli-only';
  invoked = 0;
  /** The `nativeTools` the dispatcher set on the last call: `'read-only'` for a reader, else `undefined`. */
  lastNativeTools: AdapterInvokeOptions['nativeTools'] = undefined;
  /** What the CLI call comes back with; a test that needs a failed call replaces it. */
  reply: AdapterInvokeResult = { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: false }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    this.invoked++;
    this.lastNativeTools = o.nativeTools;
    return this.reply;
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

/**
 * A cli-tier backend that edits a tracked file itself and answers as if it had only read — the F7
 * live row, as a fixture. MAF hands a cli-tier role one opaque prompt and never sends its
 * allowlist, so a role holding only reading tools still has whatever file tools its backend ships
 * with; the role reads as read-only and is not.
 */
class WritingCliAdapter implements CliAdapter {
  readonly name = 'writing-cli';
  invoked = 0;
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: false }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    this.invoked++;
    await writeFile(path.join(o.workingDir, 'sneaky.txt'), 'edited by a reader\n', 'utf8');
    return { success: true, output: 'Reviewed. APPROVED.', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

function makeTranscriptRecorder() {
  const entries: Array<{ role: string; content: string; metadata: Record<string, unknown> }> = [];
  const stub: Pick<TranscriptLogger, 'append'> = {
    append: async (role, content, metadata = {}) => { entries.push({ role, content, metadata }); },
  };
  return { entries, stub: stub as unknown as TranscriptLogger };
}

function makePolicy(handler: (toolId: string, input: ToolInput) => PolicyDecision) {
  const calls: Array<{ toolId: string; input: ToolInput }> = [];
  return {
    calls,
    stub: {
      evaluate: async (toolId: unknown, input: ToolInput, _ctx: ToolContext) => {
        calls.push({ toolId: String(toolId), input });
        return handler(String(toolId), input);
      },
    } as unknown as PolicyEngine,
  };
}

function makeAttestor() {
  const records: Array<{ toolId: string; result: ToolResult }> = [];
  const diffHashes: Array<{ key: string; diff: string }> = [];
  const tiers: ExecutionTierRecord[] = [];
  return {
    records,
    diffHashes,
    tiers,
    stub: {
      record: async (c: { toolId: string; result: ToolResult }) => { records.push(c); },
      recordDiffHash: (key: string, diff: string) => { diffHashes.push({ key, diff }); },
      recordExecutionTier: (record: ExecutionTierRecord) => { tiers.push(record); },
    } as unknown as Attestor,
  };
}

const ANALYST = defineRoleName('analyst');

function makeNode(role: RoleName, description = 'do the thing'): DagNode {
  return {
    id: makeNodeId('n1'), label: description, agentRole: role, dependencies: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {},
    metadata: { taskDescription: description },
  };
}

interface Fixture {
  dispatcher: RoleDispatcher;
  adapter: StubTurnAdapter | CliOnlyAdapter | WritingCliAdapter;
  transcript: ReturnType<typeof makeTranscriptRecorder>;
  policy: ReturnType<typeof makePolicy>;
  attestor: ReturnType<typeof makeAttestor>;
  workDir: string;
  cleanup: () => Promise<void>;
}

const execFileAsync = promisify(execFile);

async function makeFixture(opts: {
  roleExecution: 'cli' | 'in-process';
  adapter: StubTurnAdapter | CliOnlyAdapter | WritingCliAdapter;
  policyHandler: (toolId: string, input: ToolInput) => PolicyDecision;
  bundles?: HarnessConfig;
  /** The one role the set defines; read-only `analyst` unless a test needs a writer. */
  role?: RoleName;
  allowedTools?: string[];
}): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-dispatch-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello-world', 'utf8');
  const roleName = opts.role ?? ANALYST;
  const allowedTools = opts.allowedTools ?? ['fs.read'];
  // Every node captures a start commit before it runs (F7), so the fixture is a repository with
  // one commit whatever the role holds: a writer's baseline is what its post-coder gates diff
  // against, and a reader's is what the `unexpected_change` guard diffs against. A role holding
  // no write tool used to run in a bare directory, because nothing diffed it.
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await execFileAsync('git', ['add', '-A'], { cwd: workDir });
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: workDir });
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: roleName,
    roles: [{
      role: roleName,
      systemPrompt: 'analyze',
      allowedTools: allowedTools.map(makeToolId),
      execution: opts.roleExecution,
      maxToolIterations: 4,
    }],
  }, workDir);
  const transcript = makeTranscriptRecorder();
  const policy = makePolicy(opts.policyHandler);
  const attestor = makeAttestor();
  const harness = opts.bundles ?? mintHarnessConfig({
    id: 'test',
    roleSet: { version: 1, defaultRole: roleName, roles: [{ role: roleName, allowedTools, execution: opts.roleExecution }] },
    processorBundles: [{ name: 'transcript' }, { name: 'policy-audit' }],
  });
  const dispatcher = new RoleDispatcher({
    adapter: opts.adapter,
    baseTools: createDefaultRegistry(),
    roles,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: policy.stub,
    attestor: attestor.stub,
    graph: {} as MemoryGraph,
    transcript: transcript.stub,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    cwd: workDir,
    sessionId: 's1',
    runId: makeRunId('run-1'),
    harness,
    // The writer cases here test the cli tier itself, which a writer reaches only with the
    // run's consent (D-01); tier-default.test.ts covers the refusal and the banner.
    allowUngoverned: true,
    stderr: { write: () => true },
  });
  return {
    dispatcher, adapter: opts.adapter, transcript, policy, attestor, workDir,
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

const ALLOW = (): PolicyDecision => ({ verdict: 'Allow' });

// ─── tests ─────────────────────────────────────────────────────────────────

test('in-process role: model tool call executes through the gate and reaches history', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'reading', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'done reading', toolCalls: [] },
  ];
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.match(output.value, /done reading/);

    // tool executed: history turn 2 contains the tool result with file contents
    const turn2 = adapter.histories[1] ?? [];
    const toolMsg = turn2.find((m) => m.kind === 'tool');
    assert.ok(toolMsg && toolMsg.kind === 'tool');
    assert.match(toolMsg.content, /hello-world/);
    // policy saw exactly one evaluation for fs.read
    assert.deepEqual(f.policy.calls.map((c) => c.toolId), ['fs.read']);
    // attestation recorded the gated execution
    assert.equal(f.attestor.records.length, 1);
    // adapter's legacy invoke was NOT used
    assert.equal(adapter.invoked, 0);
  } finally {
    await f.cleanup();
  }
});

test('in-process role: policy Deny prevents execution and feeds the model an error message', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'try', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'blocked, giving up', toolCalls: [] },
  ];
  const f = await makeFixture({
    roleExecution: 'in-process', adapter,
    policyHandler: () => ({ verdict: 'Deny', reason: 'test denies all' }),
  });
  try {
    await f.dispatcher.runNode(makeNode(ANALYST));
    const turn2 = adapter.histories[1] ?? [];
    const toolMsg = turn2.find((m) => m.kind === 'tool');
    assert.ok(toolMsg && toolMsg.kind === 'tool' && toolMsg.isError);
    assert.match(toolMsg.content, /policy Deny/);
    assert.equal(f.attestor.records.length, 1, 'the refusal is attested (D-13)');
    assert.equal(f.attestor.records[0]?.result.metadata['refused'], true, 'nothing executes against Deny');
  } finally {
    await f.cleanup();
  }
});

test('in-process role: tool outside the allowlist is rejected before policy', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'try', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.write', input: { path: 'x', content: 'y' } }] },
    { text: 'gave up', toolCalls: [] },
  ];
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    await f.dispatcher.runNode(makeNode(ANALYST));
    const turn2 = adapter.histories[1] ?? [];
    const toolMsg = turn2.find((m) => m.kind === 'tool');
    assert.ok(toolMsg && toolMsg.kind === 'tool' && toolMsg.isError);
    assert.match(toolMsg.content, /allowlist/);
    assert.equal(f.policy.calls.length, 0, 'not found in allowlist — policy never consulted');
  } finally {
    await f.cleanup();
  }
});

test('fallback: in-process role on a CLI-only adapter uses legacy dispatch with a warning', async () => {
  const adapter = new CliOnlyAdapter();
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'CLI-PATH');
    assert.equal(adapter.invoked, 1);
    const warn = f.transcript.entries.find((e) => e.content.includes('falling back to CLI dispatch'));
    assert.ok(warn, 'fallback is surfaced in the transcript');
  } finally {
    await f.cleanup();
  }
});

test('cli role on a TurnAdapter still uses the legacy single-invocation path', async () => {
  const adapter = new StubTurnAdapter();
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    await f.dispatcher.runNode(makeNode(ANALYST));
    assert.equal(adapter.invoked, 1);
    assert.equal(adapter.histories.length, 0);
  } finally {
    await f.cleanup();
  }
});

// ─── node outcome honesty (D-04) ───────────────────────────────────────────
// A failed adapter call and an exhausted budget used to come back as ordinary output, and the
// scheduler recorded the node as succeeded. The previous version of the maxToolIterations test
// asserted exactly that ("budget_exhausted returns without throwing").

/** The rejection a node run ends in, which must be a typed NodeFailure. */
async function failureOf(run: Promise<unknown>): Promise<NodeFailure> {
  const thrown: unknown = await run.then(() => undefined, (e: unknown) => e);
  assert.ok(thrown instanceof NodeFailure, `expected the node to fail with a NodeFailure, got: ${String(thrown)}`);
  return thrown;
}

/** More tool-calling turns than any role here may take, so the loop can only stop on its budget. */
function runawayTurns(): AssistantTurn[] {
  return Array.from({ length: 20 }, (_, i) => ({
    text: `step ${i}`,
    toolCalls: [{ toolUseId: `u${i}`, toolName: 'fs.read', input: { path: 'hello.txt' } }],
  }));
}

const WRITER = defineRoleName('scribe');

test('in-process loop: maxToolIterations caps a runaway chain, and the node fails with budget_exhausted', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = runawayTurns();
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'budget_exhausted');
    assert.match(failure.message, /budget_exhausted/);
    assert.match(failure.message, /maxTurns=4/, 'the error says which budget ran out');
    assert.equal(f.policy.calls.length, 4, 'maxToolIterations=4 from role config still caps the chain');
  } finally {
    await f.cleanup();
  }
});

test('in-process loop: a node with allowPartial succeeds on budget_exhausted and returns the reason', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = runawayTurns();
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode({ ...makeNode(ANALYST), allowPartial: true });
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'step 3', 'the partial work is still the node output');

    const outcome = out['outcome'];
    if (!outcome || outcome.kind !== 'json') assert.fail('expected a json outcome beside the output');
    const partial = outcome.value as PartialNodeOutcome;
    assert.equal(partial.status, 'partial');
    assert.equal(partial.reason, 'budget_exhausted');
    assert.match(partial.detail, /maxTurns=4/);

    const note = f.transcript.entries.find((e) => e.role === 'system' && e.content.startsWith('[partial]'));
    assert.ok(note, 'the transcript says the node was accepted as partial');
    assert.match(note.content, /budget_exhausted/);
  } finally {
    await f.cleanup();
  }
});

test('in-process loop: a node that finishes returns no partial outcome', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [{ text: 'all done', toolCalls: [] }];
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode({ ...makeNode(ANALYST), allowPartial: true });
    assert.equal(out['outcome'], undefined, 'allowPartial changes nothing for a node that completed');
  } finally {
    await f.cleanup();
  }
});

test('cli tier: success:false with exit 124 fails the node with the exit code and the output tail', async () => {
  const adapter = new CliOnlyAdapter();
  // Longer than the tail, so the test can tell "the tail" from "the whole output".
  const output = `HEAD-OF-OUTPUT ${'x'.repeat(2_000)} claude: request timed out after 120000ms`;
  adapter.reply = { success: false, output, toolCallLog: [], exitCode: 124, duration: 120_000 };
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'adapter_failed');
    assert.equal(failure.exitCode, 124);
    assert.match(failure.message, /exit code 124/);
    assert.ok(failure.message.includes('claude: request timed out after 120000ms'), 'the end of the output is in the error');
    assert.ok(!failure.message.includes('HEAD-OF-OUTPUT'), 'only the tail, not the whole output');
    assert.ok(failure.message.length < 1_000, `the error stays short (${failure.message.length} chars)`);
  } finally {
    await f.cleanup();
  }
});

test('cli tier: a transport failure is thrown as a TransportError so the scheduler may retry it', async () => {
  const adapter = new CliOnlyAdapter();
  // What ProcessSpawner reports for a timeout: exit 124 and a TransportError on the result.
  const transport = new TransportError('claude timed out after 120000ms');
  adapter.reply = { success: false, output: '', toolCallLog: [], exitCode: 124, duration: 120_000, transportError: transport };
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    let thrown: unknown;
    try { await f.dispatcher.runNode(makeNode(ANALYST)); } catch (err) { thrown = err; }
    assert.ok(thrown instanceof TransportError, 'a transport failure keeps its class (D-06)');
    assert.ok(!(thrown instanceof NodeFailure), 'and is not a judged failure');
    assert.equal(thrown.cause, transport);
    assert.match(thrown.message, /exit code 124/);
    assert.match(thrown.message, /timed out/);
  } finally {
    await f.cleanup();
  }
});

test('cli tier: a writer role that returns only whitespace fails the node', async () => {
  const adapter = new CliOnlyAdapter();
  adapter.reply = { success: true, output: '  \n\t ', toolCallLog: [], exitCode: 0, duration: 1 };
  const f = await makeFixture({
    roleExecution: 'cli', adapter, policyHandler: ALLOW,
    role: WRITER, allowedTools: ['fs.read', 'fs.write'],
  });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(WRITER)));
    assert.equal(failure.reason, 'empty_output');
    assert.equal(failure.exitCode, 0);
    assert.match(failure.message, /holds a write tool/);
    assert.match(failure.message, /exit code 0/);
  } finally {
    await f.cleanup();
  }
});

test('cli tier: a read-only role that returns empty output still succeeds', async () => {
  const adapter = new CliOnlyAdapter();
  adapter.reply = { success: true, output: '', toolCallLog: [], exitCode: 0, duration: 1 };
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, '', 'a reader with nothing to report has done no harm by saying so');
  } finally {
    await f.cleanup();
  }
});

test('cli tier: allowPartial does not rescue a failed adapter call', async () => {
  const adapter = new CliOnlyAdapter();
  adapter.reply = { success: false, output: 'Invalid API key', toolCallLog: [], exitCode: 1, duration: 1 };
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode({ ...makeNode(ANALYST), allowPartial: true }));
    assert.equal(failure.reason, 'adapter_failed', 'only budget_exhausted is partial work');
    assert.match(failure.message, /Invalid API key/);
  } finally {
    await f.cleanup();
  }
});

// ─── F7: a reader whose turn changes the tree ────────────────────────────────

/** An in-process backend that edits the tree during a turn of its own. */
class WritingTurnAdapter extends StubTurnAdapter {
  override async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    await writeFile(path.join(o.workingDir, 'sneaky.txt'), 'edited in-process\n', 'utf8');
    return super.sendTurn(history, o);
  }
}

test('cli tier: a read-only role whose backend changes the tree fails with unexpected_change (F7)', async () => {
  const adapter = new WritingCliAdapter();
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'the documented Succeeded becomes a failure');
    assert.match(failure.message, /sneaky\.txt/, 'the file it changed is named');
    assert.match(failure.message, /git -C .* diff/, 'the user is told how to see it');
    assert.match(failure.message, /git -C .* checkout --/, 'and how to undo it — MAF reverts nothing');
    assert.equal(adapter.invoked, 1);
    // The change is a subject of the run's attestation — the half the live row found empty (F7).
    assert.equal(f.attestor.diffHashes.length, 1);
    assert.equal(f.attestor.diffHashes[0]?.key, 'n1.diff');
    assert.match(f.attestor.diffHashes[0]?.diff ?? '', /sneaky\.txt/);
    assert.deepEqual(f.attestor.tiers, [{ nodeId: 'n1', role: 'analyst', tier: 'cli', adapter: 'writing-cli' }]);
  } finally {
    await f.cleanup();
  }
});

test('in-process tier: a reader whose backend edits the tree is caught the same way (F7)', async () => {
  const adapter = new WritingTurnAdapter();
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'the guard is the tier-independent mirror of no_change');
    assert.match(failure.message, /sneaky\.txt/);
    assert.equal(f.attestor.diffHashes.length, 1);
    assert.deepEqual(f.attestor.tiers, [{ nodeId: 'n1', role: 'analyst', tier: 'in-process', adapter: 'stub' }]);
  } finally {
    await f.cleanup();
  }
});

test('cli tier: the read-only toolset is handed to a reader, and not to a writer (F7)', async () => {
  // The `--tools Read,Glob,Grep` set confines a *reader*. A cli-tier writer — reachable only under
  // --allow-ungoverned — must keep the backend's own tools, or a coder could not write at all.
  const reader = new CliOnlyAdapter();
  const rf = await makeFixture({ roleExecution: 'cli', adapter: reader, policyHandler: ALLOW });
  try {
    await rf.dispatcher.runNode(makeNode(ANALYST));
    assert.equal(reader.lastNativeTools, 'read-only', 'a cli-tier reader is confined to the reading tools');
  } finally {
    await rf.cleanup();
  }

  const writer = new CliOnlyAdapter();
  const wf = await makeFixture({
    roleExecution: 'cli', adapter: writer, policyHandler: ALLOW, allowedTools: ['fs.read', 'fs.write'],
  });
  try {
    await wf.dispatcher.runNode(makeNode(ANALYST));
    assert.equal(writer.lastNativeTools, undefined, "a writer keeps the backend's own tools, not the reader set");
  } finally {
    await wf.cleanup();
  }
});

test('F7: a sibling writer\'s uncommitted change does not fail a reader', async () => {
  const adapter = new CliOnlyAdapter();
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    // No node commits between DAG nodes, so a writer that ran before this reader leaves its work in
    // the shared worktree. The reader must answer for the change it made, not for what it found —
    // diffing the whole tree against HEAD would fail it here, the false positive this closes.
    await writeFile(path.join(f.workDir, 'sibling.txt'), 'a writer got here first\n', 'utf8');
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'CLI-PATH', 'the reader changed nothing of its own, so it succeeds');
    assert.equal(f.attestor.diffHashes.length, 0, 'and nothing is recorded as a diff it made');
  } finally {
    await f.cleanup();
  }
});

test('F7: the reader\'s own change is still caught, and the diff names only its own files', async () => {
  const adapter = new WritingCliAdapter();
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    // The sibling's work is present when the reader's turn begins, so it sits in the start snapshot
    // and cancels out; only what the reader adds is diffed, recorded and named.
    await writeFile(path.join(f.workDir, 'sibling.txt'), 'a writer got here first\n', 'utf8');
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change');
    assert.match(failure.message, /sneaky\.txt/, "the reader's own file is named");
    assert.doesNotMatch(failure.message, /sibling\.txt/, "a sibling writer's work is not blamed on the reader");
    assert.doesNotMatch(
      f.attestor.diffHashes[0]?.diff ?? '', /sibling\.txt/,
      'and it is excluded from the recorded subject too',
    );
  } finally {
    await f.cleanup();
  }
});
