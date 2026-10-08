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
  ToolId,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, GateRefused, TransportError } from '@maf/types';
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
import { RoleRegistry } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';
import type { RoleConfig } from '../RoleConfig.js';
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

/** A writer tool that changes the tree and then crashes, as a real tool can. */
function crashingTool(): ToolPlugin {
  return {
    id: makeToolId('boom'), name: 'boom', description: 'writes a file, then throws',
    permissionLevel: 'write',
    declaredPaths: () => ['crashed.txt'],
    execute: async (_input, ctx: ToolContext): Promise<ToolResult> => {
      await writeFile(path.join(ctx.cwd, 'crashed.txt'), 'left behind by a crashing tool', 'utf8');
      throw new Error('the boom tool crashed half-way');
    },
  };
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
  const roleSet = { version: 1 as const, defaultRole: opts.role.role, roles: [opts.role] };
  const reviewed: string[] = [];
  const stderr: string[] = [];
  const transcript: Array<{ role: string; content: string }> = [];
  const dispatcher = new RoleDispatcher({
    adapter: opts.adapter,
    baseTools,
    roles: RoleRegistry.fromSet(roleSet, workDir, baseTools),
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: {
      record: async () => {},
      recordSecurityFindings: () => {},
    } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: {
      append: async (r: string, content: string) => { transcript.push({ role: r, content }); },
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
    dispatcher, workDir, reviewed, stderr, transcript,
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
  } finally {
    await fx.cleanup();
  }
});

test('a read-only role with no execution set still runs on the cli tier, with no banner', async () => {
  const adapter = new TurnStub();
  const fx = await makeFixture({ adapter, role: role('reviewer', READ_TOOLS), noRepository: true });
  try {
    await fx.dispatcher.runNode(nodeFor('reviewer'));
    assert.equal(adapter.invoked, 1);
    assert.equal(adapter.turnsTaken, 0);
    assert.deepEqual(fx.stderr, []);
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
  const fx = await makeFixture({ adapter, role: role('reader', READ_TOOLS, 'in-process'), noRepository: true });
  try {
    await fx.dispatcher.runNode(nodeFor('reader'));
    assert.equal(adapter.invoked, 1);
    assert.ok(fx.transcript.some((e) => e.content.includes('falling back to CLI dispatch')));
    assert.deepEqual(fx.stderr, [], 'a reader cannot change the tree through MAF, so no banner');
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
  adapter.turns = [{ text: 'trying boom', toolCalls: [{ toolUseId: 'u1', toolName: 'boom', input: {} }] }];
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
  adapter.turns = [{ text: 'trying boom', toolCalls: [{ toolUseId: 'u1', toolName: 'boom', input: {} }] }];
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
