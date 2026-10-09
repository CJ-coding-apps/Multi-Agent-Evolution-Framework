import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeCommitHash, makeRunId } from '@maf/types';
import { RollbackManager } from '../RollbackManager.js';
import { WorktreeManager } from '../WorktreeManager.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

/** A user repository with one run's worktree in it; both are deleted with the repository. */
async function repoWithRun(t: TestContext) {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await new WorktreeManager(repo).createForRun(makeRunId('r1'));
  return { repo, wt };
}

test('checkpoint() records HEAD and rollbackToLast() restores it, inside the run worktree', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  await commitFile(wt.cwd, 'app.txt', 'v1\n', 'v1');
  const checkpointHash = await mgr.checkpoint();
  assert.equal(checkpointHash, await git(['rev-parse', 'HEAD'], wt.cwd));

  await commitFile(wt.cwd, 'app.txt', 'v2 broken\n', 'v2');
  assert.notEqual(await git(['rev-parse', 'HEAD'], wt.cwd), checkpointHash);

  const restored = await mgr.rollbackToLast();
  assert.equal(restored, checkpointHash);
  assert.equal(await git(['rev-parse', 'HEAD'], wt.cwd), checkpointHash);
  assert.equal(await readFile(path.join(wt.cwd, 'app.txt'), 'utf8'), 'v1\n');
  assert.deepEqual(mgr.history(), []);
});

test('rollbackToLast() on an empty stack returns undefined and leaves HEAD alone', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  const headBefore = await git(['rev-parse', 'HEAD'], wt.cwd);
  assert.equal(await mgr.rollbackToLast(), undefined);
  assert.equal(await git(['rev-parse', 'HEAD'], wt.cwd), headBefore);
});

test('rollbackTo() resets to a specific checkpoint and trims the stack past it', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  const cp1 = await mgr.checkpoint();
  await commitFile(wt.cwd, 'a.txt', 'a\n', 'add a');
  const cp2 = await mgr.checkpoint();
  await commitFile(wt.cwd, 'b.txt', 'b\n', 'add b');
  const cp3 = await mgr.checkpoint();
  assert.deepEqual(mgr.history(), [cp1, cp2, cp3]);

  await mgr.rollbackTo(cp2);
  assert.equal(await git(['rev-parse', 'HEAD'], wt.cwd), cp2);
  assert.deepEqual(mgr.history(), [cp1, cp2]);
});

test('peek() returns the newest checkpoint without popping', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  assert.equal(mgr.peek(), undefined);
  const cp = await mgr.checkpoint();
  assert.equal(mgr.peek(), cp);
  assert.equal(mgr.peek(), cp); // still there
  assert.deepEqual(mgr.history(), [cp]);
});

test('history() returns a copy — mutating it does not affect the stack', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  await mgr.checkpoint();
  const hist = mgr.history();
  hist.push(makeCommitHash('bogus'));
  assert.equal(mgr.history().length, 1);
});

test('currentHead() reports the worktree HEAD', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  assert.equal(await mgr.currentHead(), await git(['rev-parse', 'HEAD'], wt.cwd));
});

// ── Confinement (D-03): `git reset --hard` only ever on the run's own worktree branch ────

test("a cwd outside the run worktree is refused — the user's checkout is untouched", async (t) => {
  const { repo, wt } = await repoWithRun(t);
  await commitFile(repo, 'user.txt', 'the user kept working\n', 'user commit');
  await writeFile(path.join(repo, 'user.txt'), 'and has unsaved edits\n', 'utf8');
  const userHead = await git(['rev-parse', 'HEAD'], repo);

  const mgr = new RollbackManager(repo, wt);
  await assert.rejects(() => mgr.rollbackTo(makeCommitHash(wt.baseCommit)), /not inside the run's worktree/);
  await assert.rejects(() => mgr.checkpoint(), /not inside the run's worktree/);

  assert.equal(await git(['rev-parse', 'HEAD'], repo), userHead);
  assert.equal(await readFile(path.join(repo, 'user.txt'), 'utf8'), 'and has unsaved edits\n');
});

test('a symbolic link inside the worktree that points out of it is resolved, and refused', async (t) => {
  const { repo, wt } = await repoWithRun(t);
  const escape = path.join(wt.path, 'escape');
  await symlink(repo, escape);

  const mgr = new RollbackManager(escape, wt);
  await assert.rejects(() => mgr.checkpoint(), /not inside the run's worktree/);
  await assert.rejects(() => mgr.rollbackTo(makeCommitHash(wt.baseCommit)), /not inside the run's worktree/);
});

test('a worktree whose git link is gone falls through to the parent repository — and is refused', async (t) => {
  const { repo, wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  const cp = await mgr.checkpoint();
  await writeFile(path.join(repo, 'README.md'), 'unsaved user edit\n', 'utf8');

  // The worktree sits inside the user's checkout, so without its `.git` link the nearest
  // repository git finds from there is the user's own; a reset there would discard their edit.
  await rm(path.join(wt.path, '.git'));
  assert.equal(await git(['rev-parse', '--show-toplevel'], wt.cwd), await realpath(repo));

  await assert.rejects(() => mgr.rollbackTo(cp), /works on the repository at/);
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'unsaved user edit\n');
});

test('a reset is refused when the worktree is not on the run branch', async (t) => {
  const { wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  const cp = await mgr.checkpoint();
  await git(['checkout', '-q', '-b', 'elsewhere'], wt.cwd);
  await commitFile(wt.cwd, 'x.txt', 'x\n', 'on another branch');
  const head = await git(['rev-parse', 'HEAD'], wt.cwd);

  await assert.rejects(() => mgr.rollbackTo(cp), /expected .* the run's branch maf\/r1, but it is elsewhere/);
  assert.equal(await git(['rev-parse', 'HEAD'], wt.cwd), head);

  await git(['checkout', '-q', '--detach'], wt.cwd);
  await assert.rejects(() => mgr.rollbackTo(cp), /but it is detached/);
});

test('rollbackTo() refuses a commit that is not reachable from the run branch', async (t) => {
  const { repo, wt } = await repoWithRun(t);
  const mgr = new RollbackManager(wt.cwd, wt);
  // A commit the user made after the run began: real, but not part of the run's history.
  const userCommit = await commitFile(repo, 'user.txt', 'later user work\n', 'user commit');
  const head = await git(['rev-parse', 'HEAD'], wt.cwd);

  await assert.rejects(() => mgr.rollbackTo(makeCommitHash(userCommit)), /not reachable from the run's branch maf\/r1/);
  await assert.rejects(() => mgr.rollbackTo(makeCommitHash('0'.repeat(40))), /not reachable from the run's branch/);
  // A value that is not a hash never reaches git, where `--hard` or `--output=x` would be an option.
  await assert.rejects(() => mgr.rollbackTo(makeCommitHash('--hard')), /expected a commit hash/);
  assert.equal(await git(['rev-parse', 'HEAD'], wt.cwd), head);
});

test('without a run worktree (a --no-worktree run) checkpoints work and every reset is refused', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new RollbackManager(repo);
  const cp = await mgr.checkpoint();
  const moved = await commitFile(repo, 'w.txt', 'user work\n', 'user commit');

  await assert.rejects(() => mgr.rollbackToLast(), /no run worktree.*D-03/s);
  await assert.rejects(() => mgr.rollbackTo(cp), /no run worktree/);
  assert.equal(await git(['rev-parse', 'HEAD'], repo), moved);
  assert.deepEqual(mgr.history(), [cp], 'a refused rollback keeps its checkpoint');
});
