import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runIsolatedGit, snapshotTree } from '@maf/git-ops';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult,
  TurnMessage, AssistantTurn, DagNode, PolicyDecision, ToolContext, ToolInput, ToolResult,
  RoleName, PartialNodeOutcome, ExecutionTierRecord, ModelSurfaceRecord, AttributedChange,
  WriterLockLedger, ToolCallRecord, TaskId,
} from '@maf/types';
import {
  makeNodeId, makeRunId, makeTaskId, makeAgentId, makeToolId, makeLcmSummaryId,
  NodeFailure, TransportError,
} from '@maf/types';
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
  const records: Array<Omit<ToolCallRecord, 'id'>> = [];
  const diffHashes: Array<{ key: string; diff: string }> = [];
  const tiers: ExecutionTierRecord[] = [];
  const surfaces: ModelSurfaceRecord[] = [];
  const attributed: AttributedChange[] = [];
  return {
    records,
    diffHashes,
    tiers,
    surfaces,
    attributed,
    stub: {
      record: async (c: Omit<ToolCallRecord, 'id'>) => { records.push(c); },
      // The real Attestor answers this by task; the dispatcher reads it to count a reader's executed
      // calls (D-46). A double that omitted it would read as "no calls at all", which is the
      // unwatched case, not the did-no-work one — so the fixture answers it as the real one does.
      toolCallsForTask: (taskId: TaskId): ToolCallRecord[] =>
        records.filter((c) => c.taskId === taskId).map((c, i) => ({ id: `rec-${i}`, ...c })),
      recordDiffHash: (key: string, diff: string) => { diffHashes.push({ key, diff }); },
      recordExecutionTier: (record: ExecutionTierRecord) => { tiers.push(record); },
      recordModelSurface: (record: ModelSurfaceRecord) => { surfaces.push(record); },
      recordAttribution: (record: AttributedChange) => { attributed.push(record); },
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
  adapter: StubTurnAdapter | CliOnlyAdapter | WritingCliAdapter | MidTurnWriterAdapter
    | HeldWriterAdapter | MidTurnReaderAdapter | OversizeGateAdapter | NoRepoGateAdapter;
  transcript: ReturnType<typeof makeTranscriptRecorder>;
  policy: ReturnType<typeof makePolicy>;
  attestor: ReturnType<typeof makeAttestor>;
  workDir: string;
  cleanup: () => Promise<void>;
}

const execFileAsync = promisify(execFile);

/** A promise and its resolver, so an ordering the test depends on is a resolution, not a sleep. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * git's own view — sha256 of the diff the digest is over, reproducing it exactly as
 * `docs/SECURITY.md` prescribes. `runIsolatedGit` supplies the config isolation
 * (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`); the four flags are the ones the
 * digest was taken with — `--text` because a plain diff prints "Binary files … differ" for a
 * binary change rather than its bytes, `--no-ext-diff`/`--no-textconv` because a host's own
 * `diff.*` or textconv drivers would otherwise change the output.
 */
async function treeDiffSha256(cwd: string, from: string, to: string): Promise<string> {
  const { stdout } = await runIsolatedGit(
    cwd,
    ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', from, to],
  );
  return crypto.createHash('sha256').update(stdout, 'utf8').digest('hex');
}

async function makeFixture(opts: {
  roleExecution: 'cli' | 'in-process';
  adapter: StubTurnAdapter | CliOnlyAdapter | WritingCliAdapter | MidTurnWriterAdapter
    | HeldWriterAdapter | MidTurnReaderAdapter | OversizeGateAdapter | NoRepoGateAdapter;
  policyHandler: (toolId: string, input: ToolInput) => PolicyDecision;
  bundles?: HarnessConfig;
  /** The one role the set defines; read-only `analyst` unless a test needs a writer. */
  role?: RoleName;
  allowedTools?: string[];
  /** Several roles, for a test that needs a writer and a reader in one registry (N2's rule (b)). */
  roles?: Array<{ role: RoleName; allowedTools: string[]; execution: 'cli' | 'in-process' }>;
  /** The scheduler's writer-lock ledger (WP-3.0c); absent, the reader guard keeps its pre-3.0c behaviour. */
  writerLockLedger?: WriterLockLedger;
  /**
   * Run the dispatcher with its cwd inside a sub-directory of the repository (`<repo>/sub/dir`).
   * Git names changed paths relative to the repository *top* whatever the cwd, so the reviewed-set
   * check must anchor its pathspec at the top (`:(top,literal)`); from a sub-directory a bare
   * pathspec resolves under the cwd and matches nothing (R2/N2h).
   */
  cwdSubdir?: boolean;
  /** The context archive's assembly, when the test is about what the dispatcher does with it. */
  injector?: GraphAwareInjector;
}): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-dispatch-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello-world', 'utf8');
  const roleSpecs = opts.roles ?? [{
    role: opts.role ?? ANALYST,
    allowedTools: opts.allowedTools ?? ['fs.read'],
    execution: opts.roleExecution,
  }];
  const roleName = roleSpecs[0]!.role;
  // Every node captures a start commit before it runs (F7), so the fixture is a repository with
  // one commit whatever the role holds: a writer's baseline is what its post-coder gates diff
  // against, and a reader's is what the `unexpected_change` guard diffs against. A role holding
  // no write tool used to run in a bare directory, because nothing diffed it.
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await execFileAsync('git', ['add', '-A'], { cwd: workDir });
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: workDir });
  // R2: the dispatcher's cwd, and so every tool's root and every git call's directory, inside a
  // sub-directory of the repository — the one arrangement in which a bare pathspec and a
  // `:(top,literal)`-anchored one disagree.
  const cwd = opts.cwdSubdir ? path.join(workDir, 'sub', 'dir') : workDir;
  if (opts.cwdSubdir) await mkdir(cwd, { recursive: true });
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: roleName,
    roles: roleSpecs.map((r) => ({
      role: r.role,
      systemPrompt: 'analyze',
      allowedTools: r.allowedTools.map(makeToolId),
      execution: r.execution,
      maxToolIterations: 4,
    })),
  }, workDir);
  const transcript = makeTranscriptRecorder();
  const policy = makePolicy(opts.policyHandler);
  const attestor = makeAttestor();
  const harness = opts.bundles ?? mintHarnessConfig({
    id: 'test',
    roleSet: {
      version: 1,
      defaultRole: roleName,
      roles: roleSpecs.map((r) => ({ role: r.role, allowedTools: r.allowedTools, execution: r.execution })),
    },
    processorBundles: [{ name: 'transcript' }, { name: 'policy-audit' }],
  });
  const dispatcher = new RoleDispatcher({
    adapter: opts.adapter,
    baseTools: createDefaultRegistry(),
    roles,
    injector: opts.injector
      ?? ({ assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector),
    policy: policy.stub,
    attestor: attestor.stub,
    graph: {} as MemoryGraph,
    transcript: transcript.stub,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    cwd,
    sessionId: 's1',
    runId: makeRunId('run-1'),
    harness,
    ...(opts.writerLockLedger ? { writerLockLedger: opts.writerLockLedger } : {}),
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
    // D-46: the reader's only call was refused, so it made no executed call — it did no work, and the
    // node now fails `no_work`. The Deny path itself is unchanged; the node just no longer reads as
    // Succeeded off the prose that followed the refusal.
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'no_work');
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
    // D-46: the reader's only call was refused before policy (not on the allowlist), so no call
    // executed — the node fails `no_work`. The rejection itself is unchanged.
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'no_work');
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
  // One executed read, then the answer: the reader did its work (D-46), so it finishes and no
  // partial outcome is invented for it. A zero-call finish would now fail `no_work` instead.
  adapter.turnsToServe = [
    { text: 'reading', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'all done', toolCalls: [] },
  ];
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

// ORACLE (WP-3.0c, D-45; the F7 window). Two records a role call owes the bundle that neither tier
// had. First, every cli-tier call is a model call MAF made, so its surface — digests, the argv it
// spawned with — belongs in the record beside the governed turn's, marked `tier: 'cli'`. Second, the
// one change the reader's two snapshots cannot separate from its own: a sibling writer running during
// the reader's turn, inside the bracket. The writer lock says who held it then, and the change is
// charged to that writer's own start commit rather than to the reader.

/** A cli-tier surface of the shape an adapter reports — digests and the argv, no payload text. */
const SURFACE = {
  systemPromptSha256: 'a'.repeat(64),
  promptSha256:       'b'.repeat(64),
  toolCatalog:        '',
  outputSha256:       'c'.repeat(64),
  // Only a codex call sets this — it writes the system block and the prompt to the child's stdin as
  // one blob, so the two part-digests above cannot by themselves say what was sent (F7).
  stdinSha256:        'd'.repeat(64),
  argv:               ['--print', '--tools', '', '-p', '--', '<prompt: 6 bytes, sha256 bbbbbb…>'],
};

test('cli tier: a role call records its model surface with tier "cli", and mirrors it to the transcript (WP-3.0c)', async () => {
  const adapter = new CliOnlyAdapter();
  adapter.reply = { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1, modelSurface: SURFACE };
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'CLI-PATH', 'the surface is recorded without changing the answer');

    assert.deepEqual(
      f.attestor.surfaces,
      [{ role: 'analyst', taskId: makeTaskId('n1'), turn: 1, ...SURFACE, tier: 'cli', nativeTools: 'read-only' }],
      'the same evidence shape as a governed turn, one record, marked cli — and what the dispatcher ' +
        'asked of the backend\'s own tools (F3), which for codex and gemini no argv can show',
    );
    const note = f.transcript.entries.find((e) => e.content.startsWith('[surface]'));
    assert.ok(note, 'the surface reaches the transcript too');
    assert.equal(note.metadata['tier'], 'cli');
    assert.equal(note.metadata['agentRole'], 'analyst');
    assert.equal(note.metadata['systemPromptSha256'], SURFACE.systemPromptSha256);
    assert.equal(note.metadata['nativeTools'], 'read-only', 'the asked-for tool posture rides with the surface line');
    // F7: both text digests and the stdin digest ride with the line, so the transcript alone ties the
    // argv's elided markers to what was sent and the output to what came back.
    assert.equal(note.metadata['promptSha256'], SURFACE.promptSha256, 'the prompt digest rides');
    assert.equal(note.metadata['outputSha256'], SURFACE.outputSha256, 'and so does the output digest');
    assert.equal(note.metadata['stdinSha256'], SURFACE.stdinSha256, 'and the stdin digest a codex call carries');
    assert.deepEqual(note.metadata['argv'], SURFACE.argv);
  } finally {
    await f.cleanup();
  }
});

test('cli tier: an adapter that reports no model surface records none — absent, not empty (WP-3.0c)', async () => {
  const adapter = new CliOnlyAdapter(); // `reply` defaults to one with no modelSurface
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    await f.dispatcher.runNode(makeNode(ANALYST));
    assert.equal(f.attestor.surfaces.length, 0, 'nothing is invented for a call that reported no surface');
    assert.equal(
      f.transcript.entries.some((e) => e.content.startsWith('[surface]')), false,
      'and no transcript line either',
    );
  } finally {
    await f.cleanup();
  }
});

/**
 * A reader whose turn drives a writer node that stays *in its turn*: the writer edits the tree, then
 * parks on a deferred, so when the reader's change guard runs the writer is still a node this
 * dispatcher started as a writer (`writerNodes`), the ledger reports it holding, its gate has not
 * begun (`gating` unset) and its gate tree is not recorded (`gateTrees` unset) — rule (a)'s three
 * conditions, all true. That is the F7 window's live case, and the one thing N5's restriction must
 * not break. With `park = false` the writer instead loops on read-only turns, so the node runs out
 * of its budget: the gate runs and the node still fails — a first attempt to retry from.
 *
 * `fixture` is assigned right after `makeFixture` returns; the test releases the writer in `finally`
 * and awaits the nested run, so it finishes before the workdir is removed.
 */
class HeldWriterAdapter implements TurnAdapter {
  readonly name = 'held-writer';
  fixture!: Fixture;
  park = true;
  /** When false the reader makes no tool call at all — the live row 2b shape (F11). */
  readerMakesACall = true;
  writerDone: Promise<unknown> | undefined;
  private readerStarted = false;
  private readonly writerStarted = deferred();
  private readonly writerRelease = deferred();
  constructor(private readonly writerNode: DagNode) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    const isWriter = (opts.tools ?? []).some((t) => t.id === makeToolId('fs.write'));
    if (isWriter) {
      if (!this.park) {
        return { text: 'reading', toolCalls: [{ toolUseId: 'r1', toolName: 'fs.read', input: { path: 'hello.txt' } }] };
      }
      // On disk before the reader's turn ends, so the reader's bracket shows it; the writer then
      // parks, so its own gate is still ahead of it when the reader's guard runs.
      await writeFile(path.join(opts.workingDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
      this.writerStarted.resolve();
      await this.writerRelease.promise;
      return { text: 'wrote feature.ts', toolCalls: [] };
    }
    // The reader does its own work — one executed read (D-46) — before it answers, so its node
    // genuinely succeeds and the bracket's change is the *writer's*, which is the case under test.
    // The writer is spawned exactly once, on this first turn; the second turn only supplies the
    // final answer, so the writer is not re-entered (which would start a second nested run).
    if (!this.readerStarted) {
      this.readerStarted = true;
      this.writerDone = this.fixture.dispatcher.runNode(this.writerNode);
      await this.writerStarted.promise;
      // F11: a reader that makes no call at all answers on its first turn, so its node has zero
      // executed calls and fails `no_work` — while the writer's change, attributed below, is the
      // writer's, not a change the reader has to answer for.
      if (!this.readerMakesACall) return { text: 'investigated the code', toolCalls: [] };
      return { text: 'investigating', toolCalls: [{ toolUseId: 'q1', toolName: 'fs.read', input: { path: 'hello.txt' } }] };
    }
    return { text: 'investigated the code', toolCalls: [] };
  }
  release(): void { this.writerRelease.resolve(); }
}

test('F2: an in-process reader is excused for a writer still holding the lock across its turn (rule (a), WP-3.0c)', async () => {
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer, // the writer is mid-turn: it holds the lock and its gate is ahead of it
  };
  const adapter = new HeldWriterAdapter(writerNode);
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  adapter.fixture = f;
  try {
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'investigated the code', 'the reader answers for its own turn, not the writer\'s change');

    assert.equal(f.attestor.attributed.length, 1, 'the change is attributed, once');
    const attributed = f.attestor.attributed[0];
    assert.equal(attributed?.nodeId, 'n1');
    assert.equal(attributed?.attributedTo, writer, 'named to the writer that held the lock across the turn');
    assert.match(attributed?.diffSha256 ?? '', /^[0-9a-f]{64}$/, 'a digest of the diff, not the diff text');
    // N6: the tree ids the rule used are in the record, and the digest is reproducible from two of
    // them in the run's repository — the claim docs/SECURITY.md makes, made checkable.
    assert.match(attributed?.fromTree ?? '', /^[0-9a-f]{40}$/, 'the bracket\'s start tree id');
    assert.match(attributed?.toTree ?? '', /^[0-9a-f]{40}$/, 'and its end tree id');
    assert.notEqual(attributed?.fromTree, attributed?.toTree, 'the bracket spans a change');
    assert.equal(attributed?.writerGateTree, undefined,
      'absent under rule (a): the named writer had not gated, so there is no gate tree to name');
    assert.equal(
      await treeDiffSha256(f.workDir, attributed!.fromTree, attributed!.toTree),
      attributed?.diffSha256,
      'the SECURITY.md recipe (`... git diff --text --no-ext-diff --no-textconv --no-renames <fromTree> <toTree>`) reproduces the digest (N6)',
    );
    assert.ok(
      f.attestor.diffHashes.some((h) => h.key === 'n1.attributed.diff'),
      'the bracket diff is a subject of the run\'s statement, so the digest above points at it (F2)',
    );
    assert.equal(
      f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), false,
      'and it is not charged to the reader as its own diff',
    );

    const note = f.transcript.entries.find((e) => e.content.startsWith('[attributed]'));
    assert.ok(note, 'the attribution reaches the transcript');
    assert.equal(note.metadata['attributedTo'], writer);
    assert.equal(note.metadata['diffSha256'], attributed?.diffSha256, 'the transcript and the bundle agree');
    assert.equal(note.metadata['fromTree'], attributed?.fromTree, 'and the transcript carries the tree ids (N6)');
    assert.equal(note.metadata['toTree'], attributed?.toTree);
    assert.equal('writerGateTree' in note.metadata, false, 'absent under (a) in the transcript too');
  } finally {
    adapter.release();
    if (adapter.writerDone) await adapter.writerDone.catch(() => undefined);
    await f.cleanup();
  }
});

// F11: live row 2b's exact shape, which no committed test covered once every reader fixture was
// changed to make a call. The WP-3.0c pass ran two independent parts at maxConcurrent: 2; an analyst
// made no executed call while a writer held the writer-lock across its turn. The scheduler's own
// arrangement (two concurrent nodes) is what made it live, but the observable behaviour is rule (a)'s
// and this fixture reproduces it deterministically: the reader's bracket holds the writer's change,
// the change is charged to the writer, so the `unexpected_change` guard does not fire — and the
// reader, having called nothing, fails `no_work`. Both facts at once: attribution recorded, node still
// fails.

test('F11: a zero-call reader whose bracket is the writer\'s change is attributed, then fails no_work (live row 2b)', async () => {
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer, // the writer is mid-turn: it holds the lock and its gate is ahead of it
  };
  const adapter = new HeldWriterAdapter(writerNode);
  adapter.readerMakesACall = false;
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  adapter.fixture = f;
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'no_work', 'the reader called nothing, so it did no work');
    assert.equal(failure.message.split(';')[0], 'role "analyst" made no executed tool call across 1 turn',
      'and the message is the D-46/F10 template, one turn, zero executed calls');

    assert.equal(f.attestor.attributed.length, 1, 'the writer\'s change is still attributed, once');
    assert.equal(f.attestor.attributed[0]?.nodeId, 'n1');
    assert.equal(f.attestor.attributed[0]?.attributedTo, writer, 'named to the writer that held the lock across the turn');
    assert.ok(
      f.attestor.diffHashes.some((h) => h.key === 'n1.attributed.diff'),
      'the bracket diff is a subject of the run\'s statement — attribution is recorded even though the node fails',
    );
    assert.equal(
      f.attestor.records.filter((r) => r.taskId === makeTaskId('n1')).length, 0,
      'the reader made no executed call — the attribution is not itself work, so no_work stands',
    );
  } finally {
    adapter.release();
    if (adapter.writerDone) await adapter.writerDone.catch(() => undefined);
    await f.cleanup();
  }
});

/**
 * A writer that writes one file through a tool call and gates on it; the reader then makes
 * `readerChange` directly, in-process. Runs the writer's whole node with the real dispatcher, so
 * `reviewedPaths`/`gateTrees` are the ones a real gate records — the evidence rule (b) reads.
 */
class ReviewedWriterAdapter extends StubTurnAdapter {
  private writerTurns = 0;
  constructor(private readonly readerChange: (dir: string) => Promise<void>) { super(); }
  override async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    const isWriter = (o.tools ?? []).some((t) => t.id === makeToolId('fs.write'));
    if (isWriter) {
      this.writerTurns += 1;
      if (this.writerTurns === 1) {
        return { text: 'writing', toolCalls: [{ toolUseId: 'w1', toolName: 'fs.write', input: { path: 'w1.txt', content: 'v1\n' } }] };
      }
      return { text: 'wrote w1.txt', toolCalls: [] };
    }
    await this.readerChange(o.workingDir);
    return super.sendTurn(history, o);
  }
}

test('N2/V9: a writer that already gated is judged by its reviewed diff, not the lock it still holds (kills N2a)', async () => {
  // V9: the writer lock is held through the post-gate flush, so "still holding" is not "has not
  // gated". The writer here gated on `w1.txt` and finished; the reader's turn then writes
  // `sneaky.txt`, a path the reviewed set does not hold. Rule (a) must refuse to name a writer whose
  // gate tree is recorded — that is the only thing standing between this reader and a false excuse,
  // since a rule that tested `isHolding` alone (N2a) would name it and pass.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer, // it holds the lock through its own flush, after its gate has run
  };
  const adapter = new ReviewedWriterAdapter((dir) => writeFile(path.join(dir, 'sneaky.txt'), 'edited in-process\n', 'utf8'));
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  try {
    await f.dispatcher.runNode(writerNode); // gates on w1.txt, records its gate tree, releases nothing yet

    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'a gated writer answers for nothing the reader changed');
    assert.match(failure.message, /sneaky\.txt/);
    assert.equal(f.attestor.attributed.length, 0, 'the recorded gate tree is what refuses rule (a) here (kills N2a)');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

test('R2: from a sub-directory cwd a reviewed path rewritten after the gate still fails closed (kills N2h)', async () => {
  // Same shape as N2/V9 — a gated writer answers for its reviewed diff, and the reader rewrites a
  // path the writer reviewed — but the dispatcher's cwd is `<repo>/sub/dir`. Git names the changed
  // path relative to the repository *top* (`sub/dir/w1.txt`), while `unchangedSince` runs from the
  // sub-directory; its pathspec must therefore be anchored at the top (`:(top,literal)`). With the
  // anchoring removed (N2h) git resolves the bare `sub/dir/w1.txt` *under* the cwd — a path that does
  // not exist — matches nothing, sees an empty diff, and reports the reviewed path unchanged; the
  // check then excuses the reader and the node succeeds with an attribution. That is the fail-open
  // this test closes: with the cwd at the top the same mutation is harmless, which is why no
  // top-level test ever caught it (R2).
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer, // it holds the lock through its own flush, after its gate has run
  };
  const adapter = new ReviewedWriterAdapter(
    (dir) => writeFile(path.join(dir, 'w1.txt'), 'rewritten after the gate\n', 'utf8'),
  );
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger, cwdSubdir: true,
  });
  try {
    await f.dispatcher.runNode(writerNode); // gates on w1.txt, records its reviewed set as git named it
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change',
      'the writer reviewed this path and the reader rewrote it, so no writer excuses it (kills N2h)');
    assert.match(failure.message, /w1\.txt/, 'and the failure names the path git named, from the sub-directory too');
    assert.equal(f.attestor.attributed.length, 0, 'no attribution — the reviewed path did change');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

/**
 * A reader whose one turn changes a path's *type*: `hello.txt` stops being a regular file and becomes
 * a symlink. `git diff` writes two `diff --git` sections for it — a deletion and a creation — so the
 * section count no longer matches the single path `git diff --name-only` lists (R5, the verifier's V14).
 */
class TypeChangeReaderAdapter extends StubTurnAdapter {
  override async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    await rm(path.join(o.workingDir, 'hello.txt'));
    await symlink('hello-world', path.join(o.workingDir, 'hello.txt'));
    return super.sendTurn(history, o);
  }
}

test('R5: on a type change the reader fails closed and the message names the file git named (kills "git named none")', async () => {
  // A file-to-symlink change is not a content change: `diffSectionCount` sees two sections for the one
  // path `nameOnlyPaths` lists, so `bracketPaths` cannot settle a set and returns `undefined` — the
  // reader must fail closed rather than be excused (N4's defence). It must also say *what* git named:
  // the old message read "git named none" even though git had named `hello.txt`, which is the R5 fix.
  const adapter = new TypeChangeReaderAdapter();
  const ledger: WriterLockLedger = {
    enter() {}, exit() {}, writersOverlapping: () => [], isHolding: () => false,
  };
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW, writerLockLedger: ledger });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'a type change still fails the reader closed');
    assert.match(failure.message, /hello\.txt/,
      'the message names the path git named, even though the section count disagreed (R5)');
    assert.doesNotMatch(failure.message, /git named none/,
      'not "git named none" when git did name a file');
    assert.equal(f.attestor.attributed.length, 0, 'no attribution — the rule could not settle a complete set');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

test('F7 window: with no concurrent writer, a reader\'s changed tree still fails exactly as before (WP-3.0c)', async () => {
  const adapter = new WritingTurnAdapter();
  const ledger: WriterLockLedger = {
    enter() {}, exit() {}, writersOverlapping: () => [], isHolding: () => false,
  };
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW, writerLockLedger: ledger });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'no writer to attribute to, so the node fails');
    assert.match(failure.message, /sneaky\.txt/);
    assert.equal(f.attestor.attributed.length, 0);
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'and the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

test('F4: a cli-tier reader is never handed a writer — the ledger is not consulted on that tier (WP-3.0c)', async () => {
  // A cli-tier reader holds the writer lock itself (the scheduler serializes every cli-tier role,
  // D-01/A3), so no other writer can have been running and any change the bracket shows is its own.
  // The ledger would name a writer if asked; it must not be asked. This is the live-row hazard: an
  // attribution here would let a cli-tier reader edit the tree and pass.
  const adapter = new WritingCliAdapter();
  const writer = makeNodeId('writer-elsewhere');
  let consulted = false;
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => { consulted = true; return [writer]; },
    isHolding: () => { consulted = true; return true; },
  };
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW, writerLockLedger: ledger });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'its own change, on the tier where no other writer can be running');
    assert.match(failure.message, /sneaky\.txt/);
    assert.equal(consulted, false, 'the ledger is not consulted on the cli tier at all (F4)');
    assert.equal(f.attestor.attributed.length, 0, 'no attribution — this is exactly the F4 live row');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is a subject of the run\'s statement');
  } finally {
    await f.cleanup();
  }
});

/**
 * A reader whose turn commits a second file and drives a writer node in the middle of that turn —
 * so the writer's own gate runs while the reader's bracket is still open. That interleaving puts a
 * path in the reader's bracket which the writer's gate tree still carries unchanged, yet which the
 * writer never reviewed: the reader commits `other.ts` first, so the writer's *start commit* already
 * holds the reader's new content and its own diff never mentions the path, while the reader's
 * bracket (start tree → end tree) does. Without a second thread — `runNode` is re-entrant here, and
 * the nested call is the writer's whole turn.
 *
 * `fixture` is assigned right after `makeFixture` returns (the fixture is built from this adapter).
 */
class MidTurnWriterAdapter implements TurnAdapter {
  readonly name = 'mid-turn';
  fixture!: Fixture;
  private writerTurns = 0;
  constructor(private readonly writerNode: DagNode) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    // Identify the writer by the tool registry the role holds, not by `opts.prompt`: the in-process
    // loop passes the constant `'[turn]'` placeholder, so only the role's tools tell the two apart.
    const isWriter = (opts.tools ?? []).some((t) => t.id === makeToolId('fs.write'));
    if (isWriter) {
      this.writerTurns += 1;
      if (this.writerTurns === 1) {
        return {
          text: 'writing the feature',
          toolCalls: [{ toolUseId: 'w1', toolName: 'fs.write', input: { path: 'feature.ts', content: 'export const feature = 2;\n' } }],
        };
      }
      return { text: 'wrote feature.ts', toolCalls: [] };
    }
    // The reader: commit `other.ts` to a new content, so the nested writer's start commit already
    // carries it, then run the writer node — whose gate reads this very tree.
    await writeFile(path.join(opts.workingDir, 'other.ts'), 'reader-committed\n', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: opts.workingDir });
    await execFileAsync('git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'reader'],
      { cwd: opts.workingDir });
    await this.fixture.dispatcher.runNode(this.writerNode);
    return { text: 'investigated the code', toolCalls: [] };
  }
}

test('N2: a writer that reviewed one of the two bracket paths does not excuse the reader (kills MB2)', async () => {
  // The bracket shows two changed paths and the only overlapping writer reviewed one of them. Its own
  // gate tree equals the reader's end tree — content-unchanged holds for both paths — so the
  // reviewed-path check is the *only* thing that can refuse it. `paths.every` → `paths.some` would
  // name the writer for a change it never reviewed, which is D-42's fail-open; this pins `every`.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: () => false, // it finished: judged by its reviewed diff, not by the lock
  };
  const adapter = new MidTurnWriterAdapter(writerNode);
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  adapter.fixture = f;
  const git = (args: string[]) => execFileAsync('git', args, { cwd: f.workDir });
  try {
    await writeFile(path.join(f.workDir, 'feature.ts'), 'export const feature = 1;\n', 'utf8');
    await writeFile(path.join(f.workDir, 'other.ts'), 'committed\n', 'utf8');
    await git(['add', '-A']);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'two']);

    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));

    assert.equal(failure.reason, 'unexpected_change',
      'a writer that did not review one of the two bracket paths answers for nothing');
    assert.match(failure.message, /other\.ts/, 'the unreviewed path is named');
    assert.equal(f.attestor.attributed.length, 0, 'no attribution — this is the case `every` → `some` would excuse');
    assert.ok(
      f.attestor.diffHashes.some((h) => h.key === 'writer-elsewhere.diff' && /feature\.ts/.test(h.diff)),
      'the writer did gate on feature.ts — the reviewed path — so the rule turns on the unreviewed one',
    );
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'and the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

test('N2/N2d: a retrying writer is named on the lock only for the attempt whose gate is ahead (WP-3.0c)', async () => {
  // Rule (a) reads `gateTrees.has`, and each attempt's start clears this node's gate evidence, so the
  // entry means "gated *this* attempt". Attempt 1 runs out of its budget, so a gate runs and the node
  // still fails, leaving a gate tree behind. Attempt 2 is a fresh `runNode`: it is mid-turn while the
  // reader's guard runs, and rule (a) must fire — a rule that kept attempt 1's gate tree (N2d) would
  // see `gateTrees.has(id)` and refuse, failing the reader for a change the writer's current gate will
  // read. Of the two per-attempt clears, this test pins `gateTrees`; dropping the `reviewedPaths` clear
  // too (N2e) makes no difference on its own, because the gate's `reviewedPaths.set` overwrites that
  // key when it runs and rule (b) requires a *current* gate tree to get that far — the pair is
  // load-bearing, the one clear is not.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer,
  };
  const adapter = new HeldWriterAdapter(writerNode);
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  adapter.fixture = f;
  try {
    adapter.park = false;
    const first = await failureOf(f.dispatcher.runNode(writerNode));
    assert.equal(first.reason, 'budget_exhausted', 'attempt 1 gates and then fails, leaving its gate evidence behind');

    adapter.park = true;
    const out = await f.dispatcher.runNode(makeNode(ANALYST));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'investigated the code', 'the retrying writer is still ahead of its gate');
    assert.equal(f.attestor.attributed.length, 1, 'rule (a) fires — attempt 1\'s gate tree was cleared (kills N2d)');
    assert.equal(f.attestor.attributed[0]?.attributedTo, writer);
  } finally {
    adapter.release();
    if (adapter.writerDone) await adapter.writerDone.catch(() => undefined);
    await f.cleanup();
  }
});

/**
 * A reader whose turn drives a *cli-tier reader* node — a role that holds the writer lock (A3
 * serializes every cli-tier role) but runs no gate — so it is "holding and not gated" for its whole
 * turn: rule (a)'s two remaining conditions, and the V8 case. The outer reader's own change lands
 * after the holder's turn, inside the outer bracket.
 */
class MidTurnReaderAdapter implements TurnAdapter {
  readonly name = 'mid-turn-reader';
  fixture!: Fixture;
  constructor(private readonly lookNode: DagNode) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    return { success: true, output: 'looked', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    await this.fixture.dispatcher.runNode(this.lookNode); // its whole turn, inside the outer bracket
    await writeFile(path.join(opts.workingDir, 'sneaky.txt'), 'edited by the analyst\n', 'utf8');
    return { text: 'investigated the code', toolCalls: [] };
  }
}

test('N5/V8: a lock-holder this dispatcher did not start as a writer is never named (WP-3.0c)', async () => {
  // A cli-tier reader holds the lock for its whole turn but runs no gate, so it is "holding and not
  // gated". Rule (a) restricted to writer nodes is what stops it being named: the holder was started
  // by this dispatcher and the ledger says it holds, but it is not a writer node, so the reader's own
  // change must fail rather than be credited to it. Without the restriction the V8 live row appears —
  // a reader's edit excused by a reader that never gated.
  const LOOK = defineRoleName('look');
  const look = makeNodeId('look');
  const lookNode: DagNode = { ...makeNode(LOOK, 'look at the code'), id: look };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [look],
    isHolding: (id) => id === look,
  };
  const adapter = new MidTurnReaderAdapter(lookNode);
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'], execution: 'in-process' },
      { role: LOOK,    allowedTools: ['fs.read'], execution: 'cli' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  adapter.fixture = f;
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'the holder answers for nothing — it never gates');
    assert.match(failure.message, /sneaky\.txt/);
    assert.equal(f.attestor.attributed.length, 0, 'no attribution to a node that runs no gate (the V8 live-row hazard)');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
    assert.deepEqual(
      f.attestor.tiers.find((t) => t.nodeId === look),
      { nodeId: look, role: 'look', tier: 'cli', adapter: 'mid-turn-reader' },
      'the holder really was a cli-tier reader — holding the lock without ever gating',
    );
  } finally {
    await f.cleanup();
  }
});

/**
 * A writer whose gate throws *after* the `gating` marker is set but before its gate tree is recorded:
 * a file past the documented diff cap makes `snapshotDiff` refuse, and the marker it set before its
 * first read stands. The reader then changes its own tree.
 */
class OversizeGateAdapter implements TurnAdapter {
  readonly name = 'oversize-gate';
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    const isWriter = (opts.tools ?? []).some((t) => t.id === makeToolId('fs.write'));
    if (isWriter) {
      // Past the 8 MiB gate cap: the writer's own gate throws in `snapshotDiff`, its tree is never
      // recorded, and the `gating` marker it set before its first read stands.
      await writeFile(path.join(opts.workingDir, 'bulk.txt'), 'a'.repeat(9 * 1024 * 1024), 'utf8');
      return { text: 'wrote a large file', toolCalls: [] };
    }
    await writeFile(path.join(opts.workingDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
    return { text: 'investigated the code', toolCalls: [] };
  }
}

test('N5: a writer whose gate has begun but recorded no tree is not named on the lock (WP-3.0c)', async () => {
  // Rule (a)'s first window: the gate's `snapshotTree`/`snapshotDiff` run before `gateTrees.set`, so a
  // writer there is still holding the lock with no gate tree — the two conditions that would put it in
  // rule (a). The `gating` marker must exclude it, and rule (b) then fails closed until the tree is
  // recorded. A gate that throws leaves the marker set persistently: its diff is past the documented
  // size cap, so `snapshotDiff` refuses it after the marker is set and before the tree is recorded.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer, // mid-gate: it has released nothing
  };
  const adapter = new OversizeGateAdapter();
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  try {
    await f.dispatcher.runNode(writerNode).then(
      () => assert.fail('the gate must refuse a diff past its size cap'),
      () => undefined,
    );

    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change',
      'a writer whose gate has begun is not named on the lock — rule (b) fails closed until the tree is recorded');
    assert.match(failure.message, /feature\.ts/);
    assert.equal(f.attestor.attributed.length, 0, 'no attribution to a gate that read no tree');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

/**
 * A writer whose gate's *first* read fails: on its turn it takes the repository away — `git init`'s
 * `.git` is moved aside — so `snapshotTree`, the gate's first read, throws before it reads anything.
 * The marker set *before* that read therefore stands, and the node fails with no gate tree recorded.
 * The test puts `.git` back before the reader's turn.
 */
class NoRepoGateAdapter implements TurnAdapter {
  readonly name = 'no-repo-gate';
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    const isWriter = (opts.tools ?? []).some((t) => t.id === makeToolId('fs.write'));
    if (isWriter) {
      await rename(path.join(opts.workingDir, '.git'), path.join(opts.workingDir, '.git-away'));
      return { text: 'took the repository away', toolCalls: [] };
    }
    await writeFile(path.join(opts.workingDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
    return { text: 'investigated the code', toolCalls: [] };
  }
}

test('R3: the gate marks the writer as gating before its first read (kills N5c)', async () => {
  // `gating.add` must precede the gate's first `snapshotTree` (R3). Nothing else in the suite pins the
  // order: N5's writer throws in `snapshotDiff` — *after* that first read — so a marker moved to just
  // after `snapshotTree` would already be standing when it throws, and N5 still passes (N5c survives).
  // Here the first read itself fails, so the two orders diverge: with the ruled order the writer is
  // marked before the read, rule (a) cannot name it, and the reader fails closed on its own change;
  // with the marker moved after the first read (N5c) nothing is marked, rule (a) names the writer on
  // the lock alone, and the reader's change is excused with an attribution.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: (id) => id === writer, // mid-gate: it has released nothing
  };
  const adapter = new NoRepoGateAdapter();
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  const gitDir = path.join(f.workDir, '.git');
  try {
    await f.dispatcher.runNode(writerNode).then(
      () => assert.fail('the gate\'s first read must fail with no repository'),
      () => undefined,
    );
    await rename(`${gitDir}-away`, gitDir); // the reader's own turns need the repository back

    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change',
      'the writer began gating before its first read, so rule (a) must not name it (kills N5c)');
    assert.match(failure.message, /feature\.ts/);
    assert.equal(f.attestor.attributed.length, 0, 'no attribution — the marker was set before the gate read');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
  } finally {
    // If an assertion threw before the restore above, put `.git` back so `cleanup` can remove the tree.
    await rename(`${gitDir}-away`, gitDir).catch(() => undefined);
    await f.cleanup();
  }
});

test('R4: a git failure in the writer\'s gate still records the change first (D-42)', async () => {
  // Between `onDiff` and the path listing stands the one git call in the gate that can fail. Under
  // the old order the listing ran first, so its failure aborted the gate before the diff was a
  // subject — the node failed loudly, but D-42 says the change is recorded regardless. The diff must
  // therefore be recorded first, and the listing's failure then records an empty reviewed set
  // (readers fail closed against it) and rethrows. `onDiff` is the only seam between the two calls
  // a test can hold — the dispatcher's own reads are out of reach — so this drives `runPostCoderGates`
  // directly and drops the base commit's tree there, making the listing the *first* call to fail.
  const f = await makeFixture({
    roleExecution: 'in-process',
    adapter: new StubTurnAdapter(),
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: defineRoleName('coder'), allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    policyHandler: ALLOW,
  });
  try {
    const node = makeNode(defineRoleName('coder'), 'the writer');
    const git = (args: string[]) => execFileAsync('git', ['-C', f.workDir, ...args]);
    const startCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const baseTree = (await git(['rev-parse', `${startCommit}^{tree}`])).stdout.trim();
    const treeObject = path.join(f.workDir, '.git', 'objects', baseTree.slice(0, 2), baseTree.slice(2));
    // A change for the gate to find, so the diff is non-empty and must be recorded.
    await writeFile(path.join(f.workDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');

    const gate = f.dispatcher as unknown as {
      reviewedPaths: Map<string, Set<string>>;
      runPostCoderGates(node: DagNode, startCommit: string, onDiff: (diff: string) => void): Promise<void>;
    };
    await assert.rejects(
      gate.runPostCoderGates(node, startCommit, (diff) => {
        assert.match(diff, /feature\.ts/, 'the gate did read the change');
        rmSync(treeObject); // ...and then git can no longer name the paths the gate judged
      }),
      /git/,
      'the listing failure still propagates — the writer fails loudly, as D-42 requires',
    );
    assert.ok(
      f.attestor.diffHashes.some((h) => h.key === 'n1.diff'),
      'but the change is a subject of the run\'s statement first, so failing to name it leaves it recorded (R4)',
    );
    assert.equal(
      gate.reviewedPaths.get(node.id)?.size, 0,
      'and the writer is left with an empty reviewed set, so every reader fails closed against it rather than the gate aborting',
    );
  } finally {
    await f.cleanup();
  }
});

/** A reader that makes `change` during its turn — the exotic changes a `---`/`+++` parse misses (N4). */
class ChangeTurnAdapter extends StubTurnAdapter {
  constructor(private readonly change: (dir: string) => Promise<void>) { super(); }
  override async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    await this.change(o.workingDir);
    return super.sendTurn(history, o);
  }
}

// ─── N4: the path sets come from git, not from a parse of `---`/`+++` ─────────────────────────────
// A diff-header parse yields a path set git does not: it C-quotes a non-ASCII name (so the name
// matches nothing), emits no `---`/`+++` lines at all for a mode-only change, and collapses a pure
// rename into one header. Each of the three made the reader's change *excusable* before the fix,
// because the path list came back empty or short. Both sets now come from `git diff --name-only -z
// --no-renames`, so each change is named and fails.

test('N4/V10: a non-ASCII filename in the bracket is named as git reports it, not C-quoted (WP-3.0c)', async () => {
  const adapter = new ChangeTurnAdapter((dir) => writeFile(path.join(dir, 'café.txt'), 'bonjour\n', 'utf8'));
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change');
    assert.match(failure.message, /café\.txt/, 'the raw name git lists — what a `---`/`+++` parse C-quotes away');
    assert.doesNotMatch(failure.message, /\\303/, 'no octal escape reaches the message');
  } finally {
    await f.cleanup();
  }
});

test('N4/V11: a mode-only change is named and fails the reader (WP-3.0c)', async () => {
  const adapter = new ChangeTurnAdapter((dir) => chmod(path.join(dir, 'hello.txt'), 0o755));
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'an executable bit is a change like any other');
    assert.match(failure.message, /hello\.txt/, 'the mode-only path git names but a diff parse does not');
  } finally {
    await f.cleanup();
  }
});

test('N4/V12: a pure rename is named on both sides and fails the reader (WP-3.0c)', async () => {
  const adapter = new ChangeTurnAdapter((dir) => rename(path.join(dir, 'hello.txt'), path.join(dir, 'hi.txt')));
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change');
    assert.match(failure.message, /hello\.txt/, 'the deletion side, which rename detection collapses into the header');
    assert.match(failure.message, /hi\.txt/, 'and the addition side');
  } finally {
    await f.cleanup();
  }
});

test('N2/V3b: a reviewed path rewritten after the gate is not excused — the content check (kills N2c)', async () => {
  // Rule (b) needs both halves: `reviewedPaths` is a set of names, and a name rewritten after the gate
  // names a change the gate never judged. `w1.txt` is the writer's reviewed path and the reader's turn
  // rewrites it, so path containment holds and only `unchangedSince` can refuse — a rule with the
  // content check removed (N2c) would name the writer and excuse the rewrite.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: () => false, // it finished: only the content check is left
  };
  const adapter = new ReviewedWriterAdapter((dir) => writeFile(path.join(dir, 'w1.txt'), 'v2 — not what the gate read\n', 'utf8'));
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  try {
    await f.dispatcher.runNode(writerNode); // gates on w1.txt = v1

    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change');
    assert.match(failure.message, /w1\.txt/);
    assert.equal(f.attestor.attributed.length, 0,
      'the path is in the writer\'s reviewed set — only the content check refuses (kills N2c)');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'n1.diff'), 'the change is recorded as the reader\'s own');
  } finally {
    await f.cleanup();
  }
});

test('N2/N2b: a git failure in the content check fails the reader closed, never "reviewed" (WP-3.0c)', async () => {
  // `unchangedSince` asks git whether the gate tree still carries the bracket's path. If git cannot
  // answer, the only honest verdict is "not unchanged" — the change is unattested. Removing the gate
  // tree's object makes that one call fail while every other call in the guard still works, so a
  // content check that treats an error as "unchanged" (N2b) would name the writer and excuse it.
  const WRITER = defineRoleName('coder');
  const writer = makeNodeId('writer-elsewhere');
  const writerNode: DagNode = { ...makeNode(WRITER, 'the writer'), id: writer };
  const ledger: WriterLockLedger = {
    enter() {}, exit() {},
    writersOverlapping: () => [writer],
    isHolding: () => false,
  };
  const adapter = new ReviewedWriterAdapter((dir) => writeFile(path.join(dir, 'w1.txt'), 'v2\n', 'utf8'));
  const f = await makeFixture({
    roleExecution: 'in-process',
    roles: [
      { role: ANALYST, allowedTools: ['fs.read'],  execution: 'in-process' },
      { role: WRITER,  allowedTools: ['fs.write'], execution: 'in-process' },
    ],
    adapter, policyHandler: ALLOW, writerLockLedger: ledger,
  });
  try {
    await f.dispatcher.runNode(writerNode); // gates on w1.txt = v1
    // The gate tree, computed the same way the dispatcher took it (content-identical ⇒ same id), then
    // made unreadable to git. `extra.txt` is added afterwards so the reader's own bracket start tree is
    // a *different* object — otherwise deleting the gate tree would break the bracket diff instead.
    const gateTree = await snapshotTree(f.workDir);
    await writeFile(path.join(f.workDir, 'extra.txt'), 'x\n', 'utf8');
    await rm(path.join(f.workDir, '.git', 'objects', gateTree.slice(0, 2), gateTree.slice(2)), { force: true });

    const failure = await failureOf(f.dispatcher.runNode(makeNode(ANALYST)));
    assert.equal(failure.reason, 'unexpected_change', 'git cannot settle the content check, so the change is not "reviewed"');
    assert.match(failure.message, /w1\.txt/);
    assert.equal(f.attestor.attributed.length, 0, 'a content check that fails open (N2b) would name the writer here');
  } finally {
    await f.cleanup();
  }
});

test('an LCM summary call is written to the transcript with the surface it was made with (R8)', async () => {
  // R8: the `[surface] lcm summary` line is its own layer. The attestor's record is not enough — an
  // operator reads the transcript — so every field the engine reports about a call made on this
  // node's behalf must reach both the line and its metadata, or the call is invisible where the run
  // is actually read.
  const adapter = new CliOnlyAdapter();
  const injector = {
    assemble: async () => ({
      systemPromptPrefix: '',
      lcmSummaryCalls: [{
        summaryId: makeLcmSummaryId('sum-1'), level: 1, messages: 3, chars: 120,
        contentTokens: 30, reportedTokens: 42, tokenBudgetCharged: 42,
        model: 'summary-model',
        systemPromptSha256: 'a'.repeat(64), promptSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
      }],
    }),
  } as unknown as GraphAwareInjector;
  const f = await makeFixture({
    roleExecution: 'cli', adapter, policyHandler: ALLOW, injector,
  });
  try {
    await f.dispatcher.runNode(makeNode(ANALYST));
    const line = f.transcript.entries.find((e) => e.content.startsWith('[surface] lcm summary'));
    assert.ok(line, 'the call is in the transcript the operator reads');
    assert.match(
      line.content,
      /^\[surface\] lcm summary sum-1 \(level 1, 3 message\(s\)\): model summary-model;/,
    );
    assert.match(
      line.content,
      new RegExp(`system sha256 a{64}; prompt sha256 b{64}; output sha256 c{64}`),
    );
    assert.match(line.content, /content tokens 30; reported tokens 42$/);
    assert.equal(line.metadata.kind, 'lcm-summary');
    assert.equal(line.metadata.tier, 'cli');
    assert.equal(line.metadata.summaryId, 'sum-1');
    assert.equal(line.metadata.level, 1);
    assert.equal(line.metadata.messages, 3);
    assert.equal(line.metadata.contentTokens, 30);
    assert.equal(line.metadata.reportedTokens, 42);
    assert.equal(line.metadata.model, 'summary-model');
    assert.equal(typeof line.metadata.taskId, 'string', 'the call is attributed to the node\'s task');
  } finally {
    await f.cleanup();
  }
});

// R14, at the dispatcher: the tier a node will actually run on decides what the archive renders.
// A Dolt cue says `call lcm.expand(id)`, and only an in-process turn is handed MAF's tool registry
// to call it with, so a cli-tier role must be assembled with `mafToolsAvailable: false` — the
// injector then renders `<summaries>` rather than a cue it cannot follow. `true` for every tier is
// the mutant this test kills; the in-process half pins the other direction.
test('the dispatcher tells the injector whether the node can call MAF tools (R14)', async () => {
  const seen: Array<{ role?: string; mafToolsAvailable?: boolean }> = [];
  const injector = {
    assemble: async (
      _taskContext: string,
      _sessionId?: string,
      agentRole?: string,
      _trigger?: unknown,
      options?: { mafToolsAvailable?: boolean },
    ) => {
      seen.push({
        ...(agentRole !== undefined ? { role: agentRole } : {}),
        ...(options?.mafToolsAvailable !== undefined
          ? { mafToolsAvailable: options.mafToolsAvailable }
          : {}),
      });
      return { systemPromptPrefix: '', estimatedTokens: 0 };
    },
  } as unknown as GraphAwareInjector;

  const cli = await makeFixture({
    roleExecution: 'cli', adapter: new CliOnlyAdapter(), policyHandler: ALLOW, injector,
  });
  try {
    await cli.dispatcher.runNode(makeNode(ANALYST));
  } finally {
    await cli.cleanup();
  }
  assert.deepEqual(seen, [{ role: 'analyst', mafToolsAvailable: false }],
    'a cli-tier role has no MAF tools, so it gets summaries, not a cue it cannot call');

  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'reading', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'done reading', toolCalls: [] },
  ];
  const inProcess = await makeFixture({
    roleExecution: 'in-process', adapter, policyHandler: ALLOW, injector,
  });
  try {
    await inProcess.dispatcher.runNode(makeNode(ANALYST));
  } finally {
    await inProcess.cleanup();
  }
  assert.deepEqual(seen[1], { role: 'analyst', mafToolsAvailable: true },
    'an in-process role can call lcm.expand, so a cue is an instruction it can follow');
});

// T1: a node's answer reaches the transcript exactly once, on every path that produces one.
// The in-process transcript processor writes every step's assistant text at `step_end`; appending
// the final answer again here stored it twice — in the transcript and in `lcm_messages`, where it
// was summarized and charged twice. But the cli tier has no pipeline, and a custom bundle may
// leave the transcript processor out, so deleting the append entirely would lose the answer there.
// Each half below pins one direction: the unconditional append (T1b) and its removal (T1c).
test('a node answer reaches the transcript exactly once, on every tier (T1)', async () => {
  // The cli tier: no pipeline runs, so the dispatcher's append is the only writer.
  const cli = await makeFixture({
    roleExecution: 'cli', adapter: new CliOnlyAdapter(), policyHandler: ALLOW,
  });
  try {
    await cli.dispatcher.runNode(makeNode(ANALYST));
    const answers = cli.transcript.entries.filter((e) => e.role === 'assistant');
    assert.equal(answers.length, 1, 'the cli tier has no processor to record the answer');
    assert.equal(answers[0]!.content, 'CLI-PATH');
  } finally {
    await cli.cleanup();
  }

  // An in-process reader must execute a call, or D-46's `no_work` fails it before the answer is
  // written; the read is not what this test is about.
  const readerWithOneCall = (): StubTurnAdapter => {
    const adapter = new StubTurnAdapter();
    adapter.turnsToServe = [
      { text: 'reading', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
      { text: 'done reading', toolCalls: [] },
    ];
    return adapter;
  };

  // The default bundle: the transcript processor recorded each step, and only it.
  const recorded = await makeFixture({
    roleExecution: 'in-process', adapter: readerWithOneCall(), policyHandler: ALLOW,
  });
  try {
    await recorded.dispatcher.runNode(makeNode(ANALYST));
    const answers = recorded.transcript.entries.filter((e) => e.role === 'assistant');
    assert.deepEqual(answers.map((e) => e.content), ['reading', 'done reading'],
      'one line per step; the final answer was not appended a second time');
  } finally {
    await recorded.cleanup();
  }

  // A custom bundle without the transcript processor: nobody in the pipeline writes the answer,
  // so the dispatcher still must.
  const bare = await makeFixture({
    roleExecution: 'in-process', adapter: readerWithOneCall(), policyHandler: ALLOW,
    bundles: mintHarnessConfig({
      id: 'no-transcript',
      roleSet: {
        version: 1, defaultRole: ANALYST,
        roles: [{ role: ANALYST, allowedTools: ['fs.read'], execution: 'in-process' }],
      },
      processorBundles: [{ name: 'policy-audit' }],
    }),
  });
  try {
    await bare.dispatcher.runNode(makeNode(ANALYST));
    const answers = bare.transcript.entries.filter((e) => e.role === 'assistant');
    assert.deepEqual(answers.map((e) => e.content), ['done reading'],
      'a bundle with no transcript processor still gets the final answer, once');
  } finally {
    await bare.cleanup();
  }
});

// L3c/V8: each degraded-archive line says which thing happened. Three distinct facts used to share
// one sentence — a root too large was reported as a failed compaction, and a retry that itself
// failed claimed the engine had "retried after a tighter" target that never ran.
test('each degraded archive is reported for what happened, not as one generic line (L3l)', async () => {
  const injector = {
    assemble: async () => ({
      systemPromptPrefix: '',
      estimatedTokens: 0,
      lcmDegraded: [
        { sessionId: 's1', reason: 'root-over-budget', summaryId: makeLcmSummaryId('root-a'), tokens: 900 },
        {
          sessionId: 's1', reason: 'root-retry-failed: backend refused',
          summaryId: makeLcmSummaryId('root-b'), tokens: 901,
        },
        { sessionId: 's1', reason: 'cli-tier-cues', summaryId: makeLcmSummaryId('root-c'), tokens: 902 },
      ],
    }),
  } as unknown as GraphAwareInjector;
  const f = await makeFixture({
    roleExecution: 'cli', adapter: new CliOnlyAdapter(), policyHandler: ALLOW, injector,
  });
  try {
    await f.dispatcher.runNode(makeNode(ANALYST));
    const lines = f.transcript.entries
      .filter((e) => e.metadata['kind'] === 'lcm-degraded')
      .map((e) => e.content);
    assert.deepEqual(lines, [
      '[lcm] archive root root-a still exceeds the injector budget (900 tokens) after the one retry it is allowed; the archive omits it',
      '[lcm] archive root root-b still exceeds the injector budget (901 tokens) and its one retry failed (backend refused); the archive omits it',
      '[lcm] the cli tier cannot act on a cue; archive root root-c (902 tokens) is omitted rather than offered as one it could not expand',
    ]);
    assert.ok(
      lines.every((l) => !l.includes('tighter retry')),
      'a retry that failed is not reported as one that ran',
    );
  } finally {
    await f.cleanup();
  }
});
