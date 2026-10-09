import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AttestorHandle, GraphQueryRunner, ToolContext, ToolInput, ToolResult } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { WorktreeManager, runIsolatedGit } from '@maf/git-ops';
import type { RunWorktree } from '@maf/git-ops';
import { PolicyEngine } from '@maf/policy-engine';
import { executeToolGated } from '@maf/tool-loop';
import { createDefaultRegistry } from '@maf/tools';
import { FIXED_SUM, dirtyUserRepo, userState } from './runFixture.js';

// ORACLE (F1 of the 0.3.0 release audit, replayed): a target with no `.maf/policy.yaml` — the
// documented default — and a user checkout with staged, unstaged and untracked work. The run's
// worktree comes from `WorktreeManager.createForRun`, and every call goes through the default tool
// registry and `executeToolGated`, as the in-process coder's calls do, with a policy engine that has
// no rules. The auditor's two attacks:
//
//  1. `fs.delete .git`, then `git.reset --hard`: git found no repository in the worktree, walked up
//     to the user's, and reset it — staged and unstaged work gone, index rewritten.
//  2. `fs.write .git` = `gitdir: <repo>/.git`, then `git.add` + `git.commit`: committed onto the
//     user's branch.
//
// After each, the user's index bytes, HEAD, branch, status and files are byte-identical.

const NO_RULES: GraphQueryRunner = { async run() { return []; } };

interface Run {
  repo: string;
  run:  RunWorktree;
  call(tool: string, input: ToolInput): Promise<ToolResult>;
}

async function startRun(t: TestContext): Promise<Run> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-escape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = realpathSync(await dirtyUserRepo(root));
  const run = await new WorktreeManager(repo).createForRun(makeRunId('escape1'));
  const tools = createDefaultRegistry();
  const policy = new PolicyEngine(NO_RULES);
  const attestor: AttestorHandle = { async record() {} };
  const ctx: ToolContext = {
    cwd: run.cwd, projectRoot: run.cwd,
    runId: makeRunId('escape1'), taskId: makeTaskId('escape-task'), agentId: makeAgentId('inprocess-coder-escape'),
    sessionId: 'escape1', agentRole: 'coder', policy, attestor,
  };
  return {
    repo, run,
    async call(id, input) {
      const tool = tools.get(makeToolId(id));
      assert.ok(tool, `${id} is in the default registry`);
      return executeToolGated(tool, input, ctx, { policy, attestor });
    },
  };
}

test('F1 replay: fs.delete .git is refused before policy, and the worktree stays attached to its branch', async (t) => {
  const { repo, run, call } = await startRun(t);
  const before = await userState(repo);
  const link = await readFile(path.join(run.path, '.git'), 'utf8');

  for (const input of [{ path: '.git' }, { path: '.git', recursive: true }, { path: './.git' }]) {
    await assert.rejects(() => call('fs.delete', input), /fs\.delete refuses .*git's own data \(\.git\)/, JSON.stringify(input));
  }
  assert.equal(await readFile(path.join(run.path, '.git'), 'utf8'), link, 'the worktree\'s .git link is untouched');

  // The rest of the attack now has nothing to work with: the reset acts on the run's own branch.
  const reset = await call('git.reset', { to: 'HEAD', hard: true });
  assert.equal(reset.exitCode, 0, reset.stderr);
  assert.deepEqual(await userState(repo), before, 'the user\'s checkout is byte-identical');
});

test('F1 replay: with .git removed by hand, git.reset --hard, git.add and git.commit are refused and the user\'s checkout is untouched', async (t) => {
  const { repo, run, call } = await startRun(t);
  const before = await userState(repo);
  // Removed outside the tools — by hand, or by `test.run`, which runs the project's own code.
  await rm(path.join(run.path, '.git'));
  // The control: git itself, run in the worktree now, works on the user's repository.
  const found = (await runIsolatedGit(run.cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  assert.equal(realpathSync(found), repo, 'without the fix, every git tool would have acted on the user\'s checkout');

  const refusal = /^refusing to run git: git found no repository from .* inside the run's working tree /;
  const reset = await call('git.reset', { to: 'HEAD', hard: true });
  assert.equal(reset.exitCode, 1);
  assert.match(reset.stderr, refusal);

  await call('fs.write', { path: 'sum.js', content: FIXED_SUM });
  for (const [tool, input] of [['git.add', { paths: ['sum.js'] }], ['git.commit', { message: 'agent commit on your branch' }]] as const) {
    const r = await call(tool, input);
    assert.equal(r.exitCode, 1, `${tool}: ${r.stdout}`);
    assert.match(r.stderr, refusal, tool);
  }
  assert.deepEqual(await userState(repo), before, 'the user\'s index bytes, HEAD, branch, status and files are as they were');
});

test('F1 replay: the gitdir rewrite is refused, so git.add and git.commit land on the run\'s branch, not the user\'s', async (t) => {
  const { repo, run, call } = await startRun(t);
  const before = await userState(repo);
  const link = await readFile(path.join(run.path, '.git'), 'utf8');

  await assert.rejects(
    () => call('fs.write', { path: '.git', content: `gitdir: ${path.join(repo, '.git')}\n` }),
    /fs\.write refuses "\.git": the path names git's own data \(\.git\)/,
  );
  assert.equal(await readFile(path.join(run.path, '.git'), 'utf8'), link);

  await call('fs.write', { path: 'sum.js', content: FIXED_SUM });
  assert.equal((await call('git.add', { paths: ['sum.js'] })).exitCode, 0);
  const commit = await call('git.commit', { message: 'agent commit on your branch' });
  assert.equal(commit.exitCode, 0, commit.stderr);

  const branchHead = (await runIsolatedGit(repo, ['log', '-1', '--format=%s', run.branch])).stdout.trim();
  assert.equal(branchHead, 'agent commit on your branch', 'the commit is on the run\'s branch');
  assert.deepEqual(await userState(repo), before, 'and not on the user\'s');
});
