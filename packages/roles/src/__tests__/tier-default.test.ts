import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult,
  TurnMessage, AssistantTurn, DagNode, ToolPlugin, ToolContext, ToolResult, SecurityReviewResult,
  ToolId, ExecutionTierRecord, ToolCallRecord, TaskId,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, GateRefused, NodeFailure, TransportError } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import { mintHarnessConfig } from '@maf/harness-config';
import type { ProcessorRef } from '@maf/harness-config';
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
import { getDefaultRoleConfig } from '../defaults.js';
import { effectiveTier, isWriterForLock } from '../isWriterRole.js';

// ORACLE: D-01 — governed in-process execution is the default for writer roles. A role holding a
// write tool runs in-process unless it opts out; the cli tier for a writer needs allowUngoverned
// on the dispatcher (the run's --allow-ungoverned) and prints a banner once per run; a writer
// whose adapter cannot run the loop refuses to start instead of falling back silently. The
// scheduler's lock follows the tier a role actually runs on (audit P2: "writer-lock ignores the
// CLI fallback"). And a throw inside the loop still reaches task_end, where the processors —
// the security gate among them — observe the end of the task.

const execFileAsync = promisify(execFile);

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

/** A backend that can run the in-process loop; each turn is scripted, and may throw. */
class TurnStub implements TurnAdapter {
  readonly name = 'turn-stub';
  invoked = 0;
  turnsTaken = 0;
  turns: Array<AssistantTurn | Error> = [];
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    this.invoked++;
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    this.turnsTaken++;
    const next = this.turns.shift() ?? { text: 'final', toolCalls: [] };
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A cli-only backend whose call throws, the way a timeout or a non-zero exit reaches the dispatcher. */
class CliThrows implements CliAdapter {
  readonly name = 'cli-throws';
  invoked = 0;
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: false }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    this.invoked++;
    throw new TransportError('the backend did not finish in time');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

/** A backend with no in-process loop (Gemini's shape). */
class CliOnly implements CliAdapter {
  readonly name = 'cli-only';
  invoked = 0;
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: false }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    this.invoked++;
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

/** Codex's shape: it implements sendTurn but keeps the capability off. */
class SendTurnWithoutCapability extends TurnStub {
  override capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: false }; }
}

/** The reverse: the capability claimed, but no sendTurn for the loop to drive. */
class CapabilityWithoutSendTurn implements CliAdapter {
  readonly name = 'cap-no-turn';
  invoked = 0;
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: true }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    this.invoked++;
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

/**
 * A writer tool that cannot say which paths it would touch. A tool that throws while *running* is
 * answered to the model as a failed call (WP-2.18), but failing to declare is failing to evaluate
 * policy, which the gate still lets propagate — so this is the throw that still ends the loop.
 */
function crashingTool(): ToolPlugin {
  return {
    id: makeToolId('boom'), name: 'boom', description: 'cannot declare its paths',
    permissionLevel: 'write',
    declaredPaths: (): string[] => { throw new Error('the boom tool crashed half-way'); },
    execute: async (): Promise<ToolResult> => { throw new Error('boom must never run'); },
  };
}

/** A writer tool that changes the tree and then throws while running, as a real tool can. */
function failingTool(): ToolPlugin {
  return {
    id: makeToolId('halfway'), name: 'halfway', description: 'writes a file, then throws',
    permissionLevel: 'write',
    declaredPaths: () => ['halfway.txt'],
    execute: async (_input, ctx: ToolContext): Promise<ToolResult> => {
      await writeFile(path.join(ctx.cwd, 'halfway.txt'), 'left behind by a tool that failed', 'utf8');
      throw new Error('the halfway tool failed half-way');
    },
  };
}

/** Leaves `crashed.txt` behind through the gated fs.write, then calls boom. */
function writeThenCrash(): AssistantTurn[] {
  return [
    { text: 'writing', toolCalls: [{ toolUseId: 'u0', toolName: 'fs.write', input: { path: 'crashed.txt', content: 'left behind before the crash' } }] },
    { text: 'trying boom', toolCalls: [{ toolUseId: 'u1', toolName: 'boom', input: {} }] },
  ];
}

const WRITE_TOOLS = ['fs.read', 'fs.write'];
const READ_TOOLS = ['fs.read', 'grep'];

function role(name: string, allowedTools: string[], execution?: 'cli' | 'in-process'): RoleConfig {
  return {
    role: defineRoleName(name), systemPrompt: 'work', allowedTools: allowedTools.map(makeToolId),
    ...(execution ? { execution } : {}),
  };
}

function nodeFor(roleName: string, id = 'n1'): DagNode {
  return {
    id: makeNodeId(id), label: 'do the thing', agentRole: defineRoleName(roleName), dependencies: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {}, metadata: { taskDescription: 'do the thing' },
  };
}

interface Fixture {
  dispatcher: RoleDispatcher;
  workDir:    string;
  /** Every diff the security gate was handed. */
  reviewed:   string[];
  /** Everything written to the dispatcher's stderr. */
  stderr:     string[];
  transcript: Array<{ role: string; content: string }>;
  /** Every tier record the dispatcher handed the attestor (F7). */
  tiers:      ExecutionTierRecord[];
  cleanup:    () => Promise<void>;
}

async function makeFixture(opts: {
  adapter: CliAdapter;
  role: RoleConfig;
  allowUngoverned?: boolean;
  /** A bare directory instead of a repository with one commit. */
  noRepository?: boolean;
  /** The harness's processor bundle; empty means the default bundle. */
  bundles?: ProcessorRef[];
  gate?: (diff: string) => SecurityReviewResult;
  /** Make the transcript's append throw, after recording, for the entries this matches. */
  transcriptThrows?: (content: string) => boolean;
}): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-tier-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello', 'utf8');
  if (!opts.noRepository) {
    await execFileAsync('git', ['init', '-q'], { cwd: workDir });
    await execFileAsync('git', ['add', '-A'], { cwd: workDir });
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: workDir });
  }
  const baseTools = createDefaultRegistry();
  baseTools.register(crashingTool());
  baseTools.register(failingTool());
  const roleSet = { version: 1 as const, defaultRole: opts.role.role, roles: [opts.role] };
  const reviewed: string[] = [];
  const stderr: string[] = [];
  const transcript: Array<{ role: string; content: string }> = [];
  const tiers: ExecutionTierRecord[] = [];
  // Every call the loop attests, so `toolCallsForTask` can answer as the real Attestor does — the
  // reader's executed-call count (D-46) is read from here.
  const calls: Array<Omit<ToolCallRecord, 'id'>> = [];
  const dispatcher = new RoleDispatcher({
    adapter: opts.adapter,
    baseTools,
    roles: RoleRegistry.fromSet(roleSet, workDir, baseTools),
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: {
      record: async (call: Omit<ToolCallRecord, 'id'>) => { calls.push(call); },
      toolCallsForTask: (taskId: TaskId): ToolCallRecord[] =>
        calls.filter((c) => c.taskId === taskId).map((c, i) => ({ id: `rec-${i}`, ...c })),
      recordSecurityFindings: () => {},
      recordExecutionTier: (record: ExecutionTierRecord) => { tiers.push(record); },
    } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: {
      append: async (r: string, content: string) => {
        transcript.push({ role: r, content });
        if (opts.transcriptThrows?.(content)) throw new Error(`the transcript could not append "${content}"`);
      },
    } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    securityGate: {
      reviewDiff: async (diff: string) => {
        reviewed.push(diff);
        return opts.gate ? opts.gate(diff) : { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
    cwd: workDir,
    sessionId: 's1',
    runId: makeRunId('run-tier'),
    harness: mintHarnessConfig({
      id: 'test',
      roleSet: { version: 1, defaultRole: opts.role.role, roles: [{ ...opts.role, allowedTools: [...opts.role.allowedTools] }] },
      processorBundles: opts.bundles ?? [],
    }),
    stderr: { write: (text: string) => { stderr.push(text); return true; } },
    ...(opts.allowUngoverned !== undefined ? { allowUngoverned: opts.allowUngoverned } : {}),
  });
  return {
    dispatcher, workDir, reviewed, stderr, transcript, tiers,
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

/** A turn that writes `out.txt` through the gated fs.write, then a final answer. */
function writeThenFinish(): AssistantTurn[] {
  return [
    { text: 'writing', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.write', input: { path: 'out.txt', content: 'written in-process' } }] },
    { text: 'wrote out.txt', toolCalls: [] },
  ];
}

const UNGOVERNED_REFUSAL = /--allow-ungoverned/;

// ─── effectiveTier / isWriterForLock ─────────────────────────────────────────

test('effectiveTier: with no execution set, a writer runs in-process and a reader on the cli tier', () => {
  const adapter = new TurnStub();
  assert.equal(effectiveTier(role('coder', WRITE_TOOLS), adapter), 'in-process');
  assert.equal(effectiveTier(role('reviewer', READ_TOOLS), adapter), 'cli');
});

test('effectiveTier: an adapter that cannot run the loop puts every role on the cli tier', () => {
  for (const adapter of [new CliOnly(), new SendTurnWithoutCapability()]) {
    assert.equal(effectiveTier(role('coder', WRITE_TOOLS), adapter), 'cli', adapter.name);
    assert.equal(effectiveTier(role('reader', READ_TOOLS, 'in-process'), adapter), 'cli', adapter.name);
  }
});

test('effectiveTier: an explicit execution is honoured where the adapter allows it', () => {
  const adapter = new TurnStub();
  assert.equal(effectiveTier(role('coder', WRITE_TOOLS, 'cli'), adapter), 'cli');
  assert.equal(effectiveTier(role('reader', READ_TOOLS, 'in-process'), adapter), 'in-process');
});

test('isWriterForLock: a read-only in-process role that falls back to the cli tier holds the lock', () => {
  const tools: ToolRegistry = createDefaultRegistry();
  const reader = role('reader', ['fs.read', 'fs.list', 'grep', 'git.diff'], 'in-process');
  assert.equal(isWriterForLock(reader, new CliOnly(), tools), true,
    'the cli backend has file tools of its own whatever the allowlist says');
  assert.equal(isWriterForLock(reader, new SendTurnWithoutCapability(), tools), true);
});

test('isWriterForLock: a read-only role that really runs in-process does not; every other role does', () => {
  const tools: ToolRegistry = createDefaultRegistry();
  const adapter = new TurnStub();
  assert.equal(isWriterForLock(role('reader', ['fs.read', 'grep'], 'in-process'), adapter, tools), false);
  assert.equal(isWriterForLock(role('reviewer', READ_TOOLS), adapter, tools), true, 'no execution: a reader runs on the cli tier');
  assert.equal(isWriterForLock(role('coder', WRITE_TOOLS), adapter, tools), true, 'in-process, but it holds fs.write');
  assert.equal(isWriterForLock(role('runner', ['fs.read', 'test.run'], 'in-process'), adapter, tools), true, 'test.run is not read-level');
  const unknown = { allowedTools: [makeToolId('fs.read'), 'mcp.unknown.tool' as ToolId], execution: 'in-process' as const };
  assert.equal(isWriterForLock(unknown, adapter, tools), true, 'an unresolvable tool is not assumed harmless');
});

// ─── tier resolution in the dispatcher ───────────────────────────────────────

test('a writer role with no execution set runs in-process by default', async () => {
  const adapter = new TurnStub();
  adapter.turns = writeThenFinish();
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS) });
  try {
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(adapter.invoked, 0, 'the single opaque cli call was not used');
    assert.equal(adapter.turnsTaken, 2, 'the loop drove the backend turn by turn');
    assert.equal(fx.reviewed.length, 1, 'the security-gate processor reviewed the change at task_end');
    assert.match(fx.reviewed[0] ?? '', /written in-process/);
    assert.deepEqual(fx.stderr, [], 'a governed run prints no banner');
    assert.deepEqual(fx.tiers, [{ nodeId: 'n1', role: 'coder', tier: 'in-process', adapter: 'turn-stub' }]);
  } finally {
    await fx.cleanup();
  }
});

test('a read-only role with no execution set still runs on the cli tier, with no banner', async () => {
  const adapter = new TurnStub();
  const fx = await makeFixture({ adapter, role: role('reviewer', READ_TOOLS) });
  try {
    await fx.dispatcher.runNode(nodeFor('reviewer'));
    assert.equal(adapter.invoked, 1);
    assert.equal(adapter.turnsTaken, 0);
    assert.deepEqual(fx.stderr, []);
    // A reader on the cli tier by its own default: recorded, and with no fallback to name (F7).
    assert.deepEqual(fx.tiers, [{ nodeId: 'n1', role: 'reviewer', tier: 'cli', adapter: 'turn-stub' }]);
  } finally {
    await fx.cleanup();
  }
});

test('a read-only role outside a repository is refused on the start commit it would be diffed against', async () => {
  const adapter = new TurnStub();
  // A reader's turn is diffed now (F7), so the start commit a reader shares with a writer is
  // where a bare directory stops it — the same refusal, whether the node writes or only reads.
  const fx = await makeFixture({ adapter, role: role('reviewer', READ_TOOLS), noRepository: true });
  try {
    await assert.rejects(
      () => fx.dispatcher.runNode(nodeFor('reviewer')),
      /cannot diff the node's turn — no usable git repository[\s\S]*run "git init" in/,
    );
    assert.equal(adapter.invoked, 0, 'nothing ran without a repository to diff the turn against');
  } finally {
    await fx.cleanup();
  }
});

test('a writer role with execution: cli is refused without allowUngoverned, before anything runs', async () => {
  const adapter = new TurnStub();
  // No repository: a refusal that came after the start-commit capture would fail on that instead.
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS, 'cli'), noRepository: true });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, UNGOVERNED_REFUSAL);
      assert.match(err.message, /role "coder" holds a write tool/);
      assert.match(err.message, /execution is set to 'cli'/);
      assert.ok(!(err instanceof TransportError), 'a refusal is not retried');
      return true;
    });
    assert.equal(adapter.invoked, 0);
    assert.equal(adapter.turnsTaken, 0);
    assert.deepEqual(fx.transcript, [], 'nothing was dispatched, so nothing is on the record');
    assert.deepEqual(fx.stderr, []);
  } finally {
    await fx.cleanup();
  }
});

test('a writer role with execution: cli runs on the cli tier with allowUngoverned, and the banner prints once per run', async () => {
  const adapter = new TurnStub();
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS, 'cli'), allowUngoverned: true });
  try {
    await writeFile(path.join(fx.workDir, 'hello.txt'), 'changed for n1', 'utf8');
    await fx.dispatcher.runNode(nodeFor('coder', 'n1'));
    await writeFile(path.join(fx.workDir, 'hello.txt'), 'changed for n2', 'utf8');
    await fx.dispatcher.runNode(nodeFor('coder', 'n2'));
    assert.equal(adapter.invoked, 2);
    assert.equal(adapter.turnsTaken, 0);
    assert.equal(fx.stderr.length, 1, `one banner for the run, got ${fx.stderr.length}`);
    assert.match(fx.stderr[0] ?? '', /UNGOVERNED/);
    assert.match(fx.stderr[0] ?? '', /role "coder"/);
    assert.match(fx.stderr[0] ?? '', /--allow-ungoverned/);
    assert.ok((fx.stderr[0] ?? '').endsWith('\n'));
    const notes = fx.transcript.filter((e) => e.role === 'system' && e.content.startsWith('[ungoverned]'));
    assert.equal(notes.length, 2, 'each ungoverned node is on the run record');
    assert.equal(fx.reviewed.length, 2, 'the diff is still reviewed on the cli tier');
  } finally {
    await fx.cleanup();
  }
});

// ORACLE (F10 of the 0.3.0 release audit): a role holding read tools and test.run — execute level —
// was a reader, so it ran on the cli tier and nothing reviewed what the project's own test command
// changed. It is a writer now: in-process by default, and the security-gate processor reviews its diff.
test('a role holding test.run and no write tool runs in-process, and its change is security-reviewed', async () => {
  const adapter = new TurnStub();
  // A2 (the 0.4.0 audit): a role holding `test.run` but no `expectsChange` is judged by `no_work`, so
  // it makes a real call before answering — the point of the row is the tier and the gate, not the
  // guard, and a runner that calls nothing has not run anything.
  adapter.turns = [
    { text: 'running the tests', toolCalls: [{ toolUseId: 'u1', toolName: 'test.run', input: { runner: 'node' } }] },
    { text: 'ran the tests', toolCalls: [] },
  ];
  const fx = await makeFixture({ adapter, role: role('runner', ['fs.read', 'test.run']) });
  try {
    // What a test script can do to the tree while the node runs.
    await writeFile(path.join(fx.workDir, 'hello.txt'), 'rewritten by a test script', 'utf8');
    await fx.dispatcher.runNode(nodeFor('runner'));
    assert.equal(adapter.invoked, 0, 'not the cli tier');
    assert.equal(adapter.turnsTaken, 2);
    assert.equal(fx.reviewed.length, 1, 'the security gate reviewed the node\'s diff');
    assert.match(fx.reviewed[0] ?? '', /rewritten by a test script/);
  } finally {
    await fx.cleanup();
  }
});

// ORACLE (F3 of the 0.3.0 release audit): every Codex cli-tier call passes --full-auto, which nothing
// said. The banner an ungoverned run prints names it when the backend is codex, and only then.
test('the UNGOVERNED banner names --full-auto when the backend is codex', async () => {
  const codex = Object.assign(new CliOnly(), { name: 'codex' });
  for (const [adapter, says] of [[codex, true], [new CliOnly(), false]] as const) {
    const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS), allowUngoverned: true });
    try {
      await writeFile(path.join(fx.workDir, 'hello.txt'), 'changed', 'utf8');
      await fx.dispatcher.runNode(nodeFor('coder'));
      assert.equal(fx.stderr.length, 1);
      assert.equal(/codex is invoked with --full-auto, its sandboxed automatic mode/.test(fx.stderr[0] ?? ''), says, adapter.name);
    } finally {
      await fx.cleanup();
    }
  }
});

test('a writer whose adapter cannot run in-process refuses to start, naming --allow-ungoverned', async () => {
  const adapter = new CliOnly();
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS), noRepository: true });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, UNGOVERNED_REFUSAL);
      assert.match(err.message, /adapter "cli-only" cannot run the in-process loop/);
      return true;
    });
    assert.equal(adapter.invoked, 0, 'no silent fallback to the cli tier');
    assert.deepEqual(fx.stderr, []);
  } finally {
    await fx.cleanup();
  }
});

test('with allowUngoverned, a writer on a cli-only adapter runs on the cli tier and the banner prints once', async () => {
  const adapter = new CliOnly();
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS), allowUngoverned: true });
  try {
    await fx.dispatcher.runNode(nodeFor('coder', 'n1'));
    await fx.dispatcher.runNode(nodeFor('coder', 'n2'));
    assert.equal(adapter.invoked, 2);
    assert.equal(fx.stderr.length, 1);
    assert.match(fx.stderr[0] ?? '', /adapter "cli-only" cannot run the in-process loop/);
  } finally {
    await fx.cleanup();
  }
});

test('allowUngoverned changes nothing for a writer that can run in-process', async () => {
  const adapter = new TurnStub();
  adapter.turns = writeThenFinish();
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS), allowUngoverned: true });
  try {
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(adapter.invoked, 0);
    assert.deepEqual(fx.stderr, [], 'the flag permits the cli tier; it does not choose it');
  } finally {
    await fx.cleanup();
  }
});

test('a read-only in-process role on a cli-only adapter still falls back with a transcript note and no banner', async () => {
  const adapter = new CliOnly();
  const fx = await makeFixture({ adapter, role: role('reader', READ_TOOLS, 'in-process') });
  try {
    await fx.dispatcher.runNode(nodeFor('reader'));
    assert.equal(adapter.invoked, 1);
    assert.ok(fx.transcript.some((e) => e.content.includes('falling back to CLI dispatch')));
    // The banner is for the writer who lost its governed loop; a reader prints none — but its
    // turn is diffed all the same (F7), so this fallback is not the ungoverned hole it was.
    assert.deepEqual(fx.stderr, []);
    // The record names the fallback, so a bundle reader sees the node is not on the tier the
    // role asked for — the half a Deny rule scoped to an in-process reader could never show.
    assert.deepEqual(fx.tiers, [
      { nodeId: 'n1', role: 'reader', tier: 'cli', adapter: 'cli-only', fellBackFrom: 'in-process' },
    ]);
  } finally {
    await fx.cleanup();
  }
});

// ─── a throw inside the loop still reaches task_end ──────────────────────────

function taskEnds(fx: Fixture): string[] {
  return fx.transcript.filter((e) => e.role === 'system' && e.content.startsWith('task_end:')).map((e) => e.content);
}

test('a tool that throws inside the in-process loop still fires task_end, and its diff is reviewed once', async () => {
  const adapter = new TurnStub();
  adapter.turns = writeThenCrash();
  const fx = await makeFixture({ adapter, role: role('coder', ['fs.read', 'fs.write', 'boom']) });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), /the boom tool crashed half-way/);
    assert.deepEqual(taskEnds(fx), ['task_end: failed'], 'the transcript processor saw the task end');
    assert.equal(fx.reviewed.length, 1, 'the security-gate processor reviewed it, and nothing reviewed it again');
    assert.match(fx.reviewed[0] ?? '', /crashed\.txt/);
  } finally {
    await fx.cleanup();
  }
});

test('a tool that throws while running is answered: the node goes on, and what it left is reviewed once', async () => {
  const adapter = new TurnStub();
  adapter.turns = [{ text: 'trying halfway', toolCalls: [{ toolUseId: 'u1', toolName: 'halfway', input: {} }] }];
  const fx = await makeFixture({ adapter, role: role('coder', ['fs.read', 'fs.write', 'halfway']) });
  try {
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(adapter.turnsTaken, 2, 'the model was asked again after the failure');
    assert.deepEqual(taskEnds(fx), ['task_end: completed']);
    assert.equal(fx.reviewed.length, 1);
    assert.match(fx.reviewed[0] ?? '', /halfway\.txt/);
  } finally {
    await fx.cleanup();
  }
});

test('R2-S1: a cli-tier call that throws is still recorded, once, with error thrown and no output digest', async () => {
  const adapter = new CliThrows();
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS, 'cli'), allowUngoverned: true });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), TransportError);
    // The fixture's attestor is a stub without `recordModelSurface`, so the transcript mirror is
    // what this test can read: one line for the call that threw, and it says how it ended.
    const lines = fx.transcript.filter((e) => e.role === 'system' && e.content.startsWith('[surface]'));
    assert.equal(lines.length, 1, 'the call that threw is recorded exactly once');
    assert.match(lines[0]?.content ?? '', /error thrown/);
    assert.match(lines[0]?.content ?? '', /output sha256 \(none\)/);
  } finally {
    await fx.cleanup();
  }
});

test('R2-L2: a surface record the transcript refuses does not replace the cli call\'s own error', async () => {
  const adapter = new CliThrows();
  const fx = await makeFixture({
    adapter, role: role('coder', WRITE_TOOLS, 'cli'), allowUngoverned: true,
    transcriptThrows: (c) => c.startsWith('[surface]'),
  });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof TransportError, 'the backend\'s own failure is what the caller sees');
      assert.match(err.message, /the backend did not finish in time/);
      return true;
    });
    assert.ok(
      fx.stderr.some((l) => l.includes('could not record the model surface for role "coder"')),
      'the recording failure is reported, not swallowed silently',
    );
  } finally {
    await fx.cleanup();
  }
});

test('a backend turn that throws inside the in-process loop still fires task_end', async () => {
  const adapter = new TurnStub();
  adapter.turns = [new TransportError('the backend closed the connection mid-turn')];
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS) });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), TransportError);
    assert.deepEqual(taskEnds(fx), ['task_end: failed']);
    assert.equal(fx.reviewed.length, 0, 'nothing changed, so nothing was sent for review');
  } finally {
    await fx.cleanup();
  }
});

test('a refusal at the task_end a throw reaches outranks the original error', async () => {
  const adapter = new TurnStub();
  adapter.turns = writeThenCrash();
  const fx = await makeFixture({
    adapter, role: role('coder', ['fs.read', 'fs.write', 'boom']),
    gate: () => ({ findings: [{ severity: 'critical', category: 'x', file: 'crashed.txt', rationale: 'r', remediation: 'm' }], summary: 'blocked', passed: false }),
  });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), GateRefused);
    assert.equal(fx.reviewed.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('an in-process writer is reviewed even when the harness bundle leaves out the security-gate processor', async () => {
  // A harness's own bundle replaces the default one, and an evolved harness can carry any
  // allowlisted subset. Before D-01 a writer ran on the cli tier, which reviews regardless; now
  // that it runs in-process by default, the review cannot depend on the bundle.
  const adapter = new TurnStub();
  adapter.turns = writeThenFinish();
  const fx = await makeFixture({
    adapter, role: role('coder', WRITE_TOOLS), bundles: [{ name: 'transcript' }, { name: 'policy-audit' }],
  });
  try {
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(fx.reviewed.length, 1);
    assert.match(fx.reviewed[0] ?? '', /written in-process/);
  } finally {
    await fx.cleanup();
  }
});

// ─── verifier F3–F5: the lines the first round left unpinned ─────────────────

test('an adapter with the inProcessLoop capability but no sendTurn cannot run in-process: a writer is refused, not sent to the loop', async () => {
  // effectiveTier needs BOTH halves. Dropping the sendTurn half would hand this adapter to
  // runInProcess, which has no turn to drive and fails on "unreachable" instead of refusing.
  const adapter = new CapabilityWithoutSendTurn();
  assert.equal(effectiveTier(role('coder', WRITE_TOOLS), adapter), 'cli');
  assert.equal(effectiveTier(role('reader', READ_TOOLS, 'in-process'), adapter), 'cli');
  assert.equal(isWriterForLock(role('reader', READ_TOOLS, 'in-process'), adapter, createDefaultRegistry()), true);
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS), noRepository: true });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, UNGOVERNED_REFUSAL);
      assert.match(err.message, /adapter "cap-no-turn" cannot run the in-process loop/);
      return true;
    });
    assert.equal(adapter.invoked, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a security gate that throws a TransportError at task_end ends the task once: no synthetic task_end follows', async () => {
  const adapter = new TurnStub();
  adapter.turns = writeThenFinish();
  const fx = await makeFixture({
    adapter, role: role('coder', WRITE_TOOLS),
    gate: () => { throw new TransportError('the review model timed out'); },
  });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), TransportError);
    assert.deepEqual(taskEnds(fx), ['task_end: completed'], 'the loop reached task_end; the dispatcher must not fire it again');
    assert.equal(fx.reviewed.length, 1, 'the gate was asked once');
  } finally {
    await fx.cleanup();
  }
});

test('a task_end processor ahead of the gate that throws ends the task once, and the diff is still reviewed once', async () => {
  // The transcript processor sorts before the security gate, so when it throws at task_end the
  // review has not started — but task_end was reached, and firing it again would record the end
  // of the task twice.
  const adapter = new TurnStub();
  adapter.turns = writeThenFinish();
  const fx = await makeFixture({
    adapter, role: role('coder', WRITE_TOOLS), transcriptThrows: (c) => c.startsWith('task_end:'),
  });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), /the transcript could not append "task_end: completed"/);
    assert.deepEqual(taskEnds(fx), ['task_end: completed']);
    assert.equal(fx.reviewed.length, 1, 'the gate never ran at task_end, so the dispatcher reviewed the diff once');
    assert.match(fx.reviewed[0] ?? '', /written in-process/);
  } finally {
    await fx.cleanup();
  }
});

test('a loop that fails on malformed tool calls under a bundle without the security gate is reviewed once', async () => {
  // loop_failed is a NodeFailure, which the dispatcher's catch treats as already judged; the
  // review right after loop.run() is the only one this writer gets.
  const adapter = new TurnStub();
  const malformed: AssistantTurn = { text: 'oops', toolCalls: [], parseErrors: ['tool_call block is not JSON'] };
  adapter.turns = [writeThenFinish()[0]!, malformed, malformed, malformed, malformed];
  const fx = await makeFixture({ adapter, role: role('coder', WRITE_TOOLS), bundles: [{ name: 'transcript' }] });
  try {
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof NodeFailure);
      assert.equal(err.reason, 'loop_failed');
      return true;
    });
    assert.equal(fx.reviewed.length, 1);
    assert.match(fx.reviewed[0] ?? '', /written in-process/);
  } finally {
    await fx.cleanup();
  }
});

// ─── D-44: the built-in readers run in-process, where the gate and the record are ──────────────
// The tier is decided by the role set, not the dispatcher's caller: a shipped reader that said
// no `execution` ran ungoverned on the cli tier, and a reader on the cli tier is handed the
// backend's own file tools. In-process is where policy verdicts, redaction and attested tool
// calls exist, so it is the tier a built-in audit or review now asks for.

test('a built-in reader (analyst) runs in-process on an adapter that can drive the loop', async () => {
  const adapter = new TurnStub();
  // One executed read, then the answer: the reader does its work (D-46), so the node succeeds and
  // the tier record is what this test reads.
  adapter.turns = [
    { text: 'reading', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'the flag is read at config.ts:41', toolCalls: [] },
  ];
  const fx = await makeFixture({ adapter, role: getDefaultRoleConfig(defineRoleName('analyst'))! });
  try {
    await fx.dispatcher.runNode(nodeFor('analyst'));
    assert.equal(adapter.invoked, 0, 'not the single opaque cli call');
    assert.equal(adapter.turnsTaken, 2, 'the loop drove the backend turn by turn — the read, then the answer');
    assert.deepEqual(fx.tiers, [{ nodeId: 'n1', role: 'analyst', tier: 'in-process', adapter: 'turn-stub' }]);
  } finally {
    await fx.cleanup();
  }
});

test('a built-in reader falls back to the cli tier on an adapter without the loop, and the record names it', async () => {
  const adapter = new CliOnly();
  const fx = await makeFixture({ adapter, role: getDefaultRoleConfig(defineRoleName('security'))! });
  try {
    await fx.dispatcher.runNode(nodeFor('security'));
    assert.equal(adapter.invoked, 1, 'the cli tier, not the loop');
    assert.ok(fx.transcript.some((e) => e.content.includes('falling back to CLI dispatch')));
    assert.deepEqual(fx.tiers, [
      { nodeId: 'n1', role: 'security', tier: 'cli', adapter: 'cli-only', fellBackFrom: 'in-process' },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('roles.yaml: an execution other than cli or in-process is refused, naming the value and the two allowed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-exec-'));
  try {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, JSON.stringify({
      version: 1, defaultRole: 'coder',
      roles: [{ role: 'coder', systemPrompt: 'x', allowedTools: ['fs.write'], execution: 'inprocess' }],
    }), 'utf8');
    await assert.rejects(RoleRegistry.fromYamlOrDefault(file, dir, createDefaultRegistry()), (err: unknown) => {
      assert.ok(err instanceof RoleConfigError);
      assert.match(err.message, /role "coder"/i);
      assert.match(err.message, /"inprocess"/);
      assert.match(err.message, /'cli' or 'in-process'/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
