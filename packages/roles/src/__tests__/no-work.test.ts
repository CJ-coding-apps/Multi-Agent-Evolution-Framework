import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeResult, AssistantTurn, DagNode,
  ToolCallRecord, TaskId, PolicyDecision,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, makeTaskId, NodeFailure } from '@maf/types';
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

// ORACLE: D-46(ii) (WP-3.1) — a verdict is read from the record, not the narrative. Live row 2b of
// the 3.0c pass: an in-process `analyst` ran with the host's native tools disabled (`--tools ''`),
// tried Read/Glob/Grep anyway, was refused ("No such tool available"), gave up — and MAF read
// `Succeeded` off the prose. The record said what happened: zero calls, one turn, a refusal. A
// non-writer role that finishes with a final answer after making no executed tool call now fails
// `no_work`; a writer with zero calls still fails `no_change` (D-32), never `no_work`. `Allow` is a
// call that ran — a call the policy refused left the tree exactly as it found it, so it is no work.

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
  deps: { policy?: PolicyEngine; attestor?: Attestor } = {},
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
      /^role "analyst" made no tool call across 1 turn; its answer: "Everything is fine\."$/,
    );
    assert.equal(attestor.toolCallsForTask(makeTaskId('analyst-1')).length, 0, 'the record says it made no call');
  } finally {
    await fx.cleanup();
  }
});

test('the no_work message collapses newlines and keeps only the first 200 characters of the answer', async () => {
  const long = `${'a'.repeat(250)}\nb\ndone`;
  const fx = await makeFixture(readerRole('analyst'), new ScriptedTurns([], long));
  try {
    const failure = await failureOf(fx.dispatcher.runNode(nodeFor('analyst')));
    assert.equal(failure.reason, 'no_work');
    const quoted = failure.message.slice(failure.message.indexOf('its answer: ') + 'its answer: '.length);
    const excerpt = JSON.parse(quoted) as string;
    assert.equal(excerpt.length, 200, 'exactly the first 200 characters');
    assert.equal(excerpt, 'a'.repeat(200));
    assert.ok(!failure.message.includes('b'), 'the text past 200 characters is not carried');
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
    assert.match(failure.message, /^role "analyst" made no tool call across 2 turns; its answer: "I was not permitted to read\."/);
    assert.match(failure.message, /; 1 tool call was denied or refused by policy: deny-reads \(fs\.read\)$/);
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
