import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { makeRunId, makeTaskId } from '@maf/types';
import { BranchIsolator } from '../BranchIsolator.js';
import { WorktreeManager } from '../WorktreeManager.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

const TASK = makeTaskId('t1');

async function repoWithRun(t: TestContext) {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await new WorktreeManager(repo).createForRun(makeRunId('r1'));
  return { repo, wt };
}

test("createBranch() starts at the worktree's baseCommit, not at main, even after main moved on", async (t) => {
  const { repo, wt } = await repoWithRun(t);
  const movedMain = await commitFile(repo, 'later.txt', 'the user kept working\n', 'user commit');

  const iso = new BranchIsolator(wt);
  const info = await iso.createBranch(TASK);

  assert.equal(info.name, 'maf/r1-t1');
  assert.equal(info.baseSha, wt.baseCommit);
  assert.notEqual(info.baseSha, movedMain);
  assert.equal(await git(['rev-parse', 'HEAD'], wt.cwd), wt.baseCommit);
  assert.equal(await iso.currentBranch(), 'maf/r1-t1');
  assert.equal(await git(['symbolic-ref', 'HEAD'], repo), 'refs/heads/main', "the user's checkout never switches");
});

test('createBranch() sanitizes the task part of the name and caps it at 40 characters', async (t) => {
  const { wt } = await repoWithRun(t);
  const iso = new BranchIsolator(wt);
  const info = await iso.createBranch(makeTaskId('x'.repeat(120) + ' unsafe!chars'));
  assert.equal(info.name, `maf/r1-${'x'.repeat(40)}`);
  assert.doesNotMatch(info.name.slice('maf/'.length), /[^a-zA-Z0-9-]/);
});

test("a git failure comes back as a full sentence naming the branch, not git's raw output", async (t) => {
  const { wt } = await repoWithRun(t);
  const iso = new BranchIsolator(wt);
  await iso.createBranch(makeTaskId('x.y'));
  // 'x.y' and 'x_y' sanitize to the same name; the second create is git's refusal.
  await assert.rejects(() => iso.createBranch(makeTaskId('x_y')), (err: Error) => {
    assert.match(err.message, /^cannot create the task branch maf\/r1-x-y at [0-9a-f]{12} in the worktree of run r1 at .* \(git said: .*already exists.*\)\.$/s);
    assert.doesNotMatch(err.message, /Command failed/);
    return true;
  });
});

test("switchTo() moves between the run branch and its task branches, and refuses anything else", async (t) => {
  const { wt } = await repoWithRun(t);
  const iso = new BranchIsolator(wt);
  const info = await iso.createBranch(TASK);
  await iso.switchTo(wt.branch);
  assert.equal(await iso.currentBranch(), 'maf/r1');
  await iso.switchTo(info.name);
  assert.equal(await iso.currentBranch(), info.name);

  await assert.rejects(() => iso.switchTo('main'), /not this run's/);
  assert.equal(await iso.currentBranch(), info.name);
});

test('deleteBranch() removes a merged branch; force deletes an unmerged one; it never deletes one it did not create', async (t) => {
  const { wt } = await repoWithRun(t);
  const iso = new BranchIsolator(wt);
  const info = await iso.createBranch(TASK);
  await commitFile(wt.cwd, 'w.txt', 'w\n', 'unmerged work');
  await iso.switchTo(wt.branch);

  // Non-force delete of an unmerged branch fails silently (caught) — branch survives
  await iso.deleteBranch(info.name);
  assert.notEqual(await git(['branch', '--list', info.name], wt.cwd), '');

  await iso.deleteBranch(info.name, true);
  assert.equal(await git(['branch', '--list', info.name], wt.cwd), '');

  await assert.rejects(() => iso.deleteBranch('main', true), /not this run's/);
  await assert.rejects(() => iso.deleteBranch(wt.branch, true), /not this run's/);
});

test('there is no merge operation: MAF never merges (D-03)', () => {
  // The run path cannot call what does not exist; the result reaches the user as the
  // `git merge maf/<runId>` command WorktreeManager.finish returns.
  assert.equal('mergeBranch' in BranchIsolator.prototype, false);
});
