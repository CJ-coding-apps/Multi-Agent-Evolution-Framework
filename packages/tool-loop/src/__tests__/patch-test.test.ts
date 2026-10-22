import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  makeCommitHash, makeRunId, makeTaskId, makeToolId,
} from '@maf/types';
import type {
  TurnAdapter, TurnMessage, AssistantTurn, AdapterInvokeOptions, AdapterInvokeResult,
  AdapterCapabilities, ToolPlugin, ToolId, ToolContext, ToolResult, ToolCallRecord,
  PolicyDecision, PolicyEngineHandle, AttestorHandle, CommitHash,
} from '@maf/types';
import { RollbackManager, runIsolatedGit } from '@maf/git-ops';
import { InProcessAgentLoop } from '../index.js';
import type { PatchTestDeps, PatchTestRollback } from '../index.js';

// ORACLE (WP-3.5, D-18): with `--strategy patch-test`, a coder's `patch.apply` is an attempt in a
// RED-GREEN cycle. The patch is applied, the project's tests are run, and a failing result is rolled
// back to the pre-patch commit before the model is told what failed. After N consecutive failures
// the breaker trips and the node fails with the attempts attached. A rollback may only move the
// run's own worktree branch (D-03) — the same confinement `git reset --hard` already had.

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

class ScriptedAdapter implements TurnAdapter {
  readonly name = 'scripted';
  constructor(private readonly turns: AssistantTurn[]) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    return { success: true, output: '', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield ''; }
  async sendTurn(_h: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    return this.turns.shift() ?? { text: 'final', toolCalls: [] };
  }
}

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

const OK = (stdout = ''): ToolResult => ({ stdout, stderr: '', exitCode: 0, duration: 0, metadata: {} });
const FAIL = (stderr: string): ToolResult => ({ stdout: '', stderr, exitCode: 1, duration: 0, metadata: {} });

/** A tool that runs the given function, with nothing between it and the gate. */
function tool(id: string, run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>): ToolPlugin {
  return {
    id: makeToolId(id) as ToolId,
    name: id,
    description: `test ${id}`,
    permissionLevel: 'write',
    declaredPaths(): string[] { return []; },
    async execute(input, ctx) { return run(input as Record<string, unknown>, ctx); },
  };
}

/** Records every checkpoint and reset; the real one is exercised against git below. */
class RecordingRollback implements PatchTestRollback {
  checkpoints: CommitHash[] = [];
  resets: Array<{ to: CommitHash; removeUntracked?: boolean }> = [];
  private seq = 0;
  async checkpoint(): Promise<CommitHash> {
    // Lowercase hex, as git prints it and as RollbackManager's guard requires.
    const hash = makeCommitHash((++this.seq).toString(16).padStart(40, '0'));
    this.checkpoints.push(hash);
    return hash;
  }
  async rollbackTo(to: CommitHash, opts?: { removeUntracked?: boolean }): Promise<void> {
    this.resets.push({ to, ...(opts ? { removeUntracked: opts.removeUntracked } : {}) });
  }
}

const patchCall = (id: string): AssistantTurn => ({
  text: `patch ${id}`,
  toolCalls: [{ toolUseId: `u-${id}`, toolName: 'patch.apply', input: { diff: `diff ${id}` } }],
});

const baseOpts = {
  role: 'coder', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'fix it',
  workingDir: '/tmp', projectRoot: '/tmp', sessionId: 's1',
};

function loopWith(
  turns: AssistantTurn[],
  tools: ToolPlugin[],
  patchTest: PatchTestDeps,
): InProcessAgentLoop {
  const attestor = new SpyAttestor();
  return new InProcessAgentLoop(
    { ...baseOpts, tools, maxTurns: 12, timeoutMs: 60_000 },
    { adapter: new ScriptedAdapter(turns), policy: ALLOW, attestor, runId: makeRunId('r1'), taskId: makeTaskId('t1'), patchTest },
  );
}

test('a failing test rolls the patch back to the pre-patch commit and tells the model what failed', async () => {
  const rollback = new RecordingRollback();
  const loop = loopWith(
    [patchCall('one')],
    [
      tool('patch.apply', async () => OK('applied')),
      tool('test.run', async () => FAIL('FAIL sum.test.js: expected 2, got 3')),
    ],
    { rollback, maxConsecutiveFailures: 3 },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed');
  assert.equal(rollback.checkpoints.length, 1, 'one checkpoint per patch attempt');
  assert.deepEqual(rollback.resets, [{ to: rollback.checkpoints[0], removeUntracked: true }],
    'rolled back to the pre-patch commit, untracked files the patch created included');
  const toolMessage = result.history.find((m) => m.kind === 'tool');
  assert.ok(toolMessage && toolMessage.kind === 'tool');
  assert.equal(toolMessage.isError, true);
  assert.match(toolMessage.content, /rolled back/i);
  assert.match(toolMessage.content, /expected 2, got 3/);
});

test('a passing test keeps the patch: no rollback, and the model sees the test result', async () => {
  const rollback = new RecordingRollback();
  const loop = loopWith(
    [patchCall('one')],
    [
      tool('patch.apply', async () => OK('applied')),
      tool('test.run', async () => OK('tests 5\npass 5')),
    ],
    { rollback, maxConsecutiveFailures: 3 },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed');
  assert.equal(rollback.checkpoints.length, 1);
  assert.deepEqual(rollback.resets, []);
  const toolMessage = result.history.find((m) => m.kind === 'tool');
  assert.ok(toolMessage && toolMessage.kind === 'tool');
  assert.equal(toolMessage.isError, false);
  assert.match(toolMessage.content, /pass 5/);
});

test('N consecutive failures trip the breaker and the node fails with every attempt attached', async () => {
  const rollback = new RecordingRollback();
  let n = 0;
  const loop = loopWith(
    [patchCall('one'), patchCall('two'), patchCall('three')],
    [
      tool('patch.apply', async () => OK('applied')),
      tool('test.run', async () => FAIL(`failure ${++n}`)),
    ],
    { rollback, maxConsecutiveFailures: 2 },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /2 consecutive/i);
  assert.match(result.error ?? '', /#1/);
  assert.match(result.error ?? '', /failure 1/);
  assert.match(result.error ?? '', /#2/);
  assert.match(result.error ?? '', /failure 2/);
  assert.equal(rollback.resets.length, 2, 'two failed patches, two rollbacks; the loop stops at the trip');
  assert.equal(n, 2, 'the third scripted patch is never applied');
});

test('the count is consecutive: a success between failures resets it', async () => {
  const rollback = new RecordingRollback();
  const results = [FAIL('first'), OK('passed'), FAIL('third')];
  const loop = loopWith(
    [patchCall('one'), patchCall('two'), patchCall('three')],
    [
      tool('patch.apply', async () => OK('applied')),
      tool('test.run', async () => results.shift() ?? OK()),
    ],
    { rollback, maxConsecutiveFailures: 2 },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed', 'two failures separated by a pass do not trip a 2-failure breaker');
  assert.equal(rollback.resets.length, 2);
});

test('a patch that fails to apply is reported and never tested or rolled back', async () => {
  const rollback = new RecordingRollback();
  let tests = 0;
  const loop = loopWith(
    [patchCall('one')],
    [
      tool('patch.apply', async () => FAIL('patch: malformed hunk header')),
      tool('test.run', async () => { tests++; return OK(); }),
    ],
    { rollback, maxConsecutiveFailures: 3 },
  );

  const result = await loop.run();

  assert.equal(tests, 0, 'nothing was applied, so nothing is tested');
  assert.equal(rollback.checkpoints.length, 1);
  assert.deepEqual(rollback.resets, [], 'nothing was applied, so there is nothing to roll back');
  const toolMessage = result.history.find((m) => m.kind === 'tool');
  assert.ok(toolMessage && toolMessage.kind === 'tool');
  assert.match(toolMessage.content, /malformed hunk/);
});

test('a role without test.run fails closed rather than applying patches untested', async () => {
  const rollback = new RecordingRollback();
  let applied = 0;
  const loop = loopWith(
    [patchCall('one')],
    [tool('patch.apply', async () => { applied++; return OK('applied'); })],
    { rollback, maxConsecutiveFailures: 3 },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /test\.run/);
  assert.equal(applied, 0, 'the patch is not applied without a way to test it');
  assert.deepEqual(rollback.resets, []);
});

test('a real worktree: the failure leaves the branch at the checkpoint and no untracked file behind', async (t) => {
  const repo = await gitRepo(t);
  const before = (await runIsolatedGit(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const rollback = new RollbackManager(repo, { path: repo, branch: 'maf/r1' });

  const loop = loopWith(
    [patchCall('one')],
    [
      // Creates a file the patch protocol can add, and fails its test.
      tool('patch.apply', async (_i, ctx) => {
        await writeFile(path.join(ctx.cwd, 'sum.js'), 'module.exports = 3;\n', 'utf8');
        return OK('applied');
      }),
      tool('test.run', async () => FAIL('expected 2, got 3')),
    ],
    { rollback, maxConsecutiveFailures: 3 },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed');
  const after = (await runIsolatedGit(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(after, before, 'the branch is back at the pre-patch commit');
  const status = (await runIsolatedGit(repo, ['status', '--porcelain'])).stdout;
  assert.equal(status, '', 'the file the patch created is gone, not left untracked');
  await assert.rejects(readFile(path.join(repo, 'sum.js'), 'utf8'), /ENOENT/);
});

async function gitRepo(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-patch-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => runIsolatedGit(root, args);
  await git('init', '-q');
  await git('config', 'user.email', 'test@maf.local');
  await git('config', 'user.name', 'test');
  await writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'baseline');
  await git('checkout', '-q', '-b', 'maf/r1');
  return root;
}
