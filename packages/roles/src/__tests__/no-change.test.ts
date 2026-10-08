import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeResult, AssistantTurn, DagNode,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, NodeFailure, TransportError } from '@maf/types';
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

// ORACLE: D-32 — a role says whether it is expected to change the tree. A cli-tier backend that
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

/** An in-process backend that answers at once without calling a tool. */
class SilentTurns extends ScriptedCli implements TurnAdapter {
  override capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: true }; }
  async sendTurn(): Promise<AssistantTurn> { return { text: 'nothing to do', toolCalls: [] }; }
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

async function makeFixture(role: RoleConfig, adapter: CliAdapter): Promise<Fixture> {
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
    policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: { record: async () => {}, recordSecurityFindings: () => {} } as unknown as Attestor,
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

test('on the in-process tier expectsChange is not judged: every tool call is on the record', async () => {
  const fx = await makeFixture(CODER, new SilentTurns());
  try {
    const out = await fx.dispatcher.runNode(nodeFor('coder'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'nothing to do' });
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
