import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { makeRunId, makeTaskId } from '@maf/types';
import { WorktreeManager } from '../WorktreeManager.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

const RUN  = makeRunId('r1');
const TASK = makeTaskId('t1');

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

test('create() makes an isolated worktree on a sanitized maf/ branch at current HEAD', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  t.after(async () => { await mgr.remove(TASK); await rm(repo, { recursive: true, force: true }); });

  const headSha = await git(['rev-parse', 'HEAD'], repo);
  const info = await mgr.create(TASK, RUN);

  assert.ok(await exists(info.path), 'worktree dir should exist');
  assert.match(info.branch, /^maf\/run-r1-task-t1$/);
  assert.equal(info.originalSha, headSha);
  assert.equal(info.taskId, TASK);
  assert.equal(info.runId, RUN);

  // The worktree is checked out on the new branch
  const wtBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], info.path);
  assert.equal(wtBranch, info.branch);
  // Main checkout is untouched
  const mainBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  assert.equal(mainBranch, 'main');
});

test('create() sanitizes unsafe characters in branch names', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  const task = makeTaskId('t space!and@stuff');
  t.after(async () => { await mgr.remove(task); await rm(repo, { recursive: true, force: true }); });

  const info = await mgr.create(task, makeRunId('r.2'));
  assert.doesNotMatch(info.branch, /[^a-zA-Z0-9/-]/);
});

test('harvest() returns the diff of work committed inside the worktree', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  t.after(async () => { await mgr.remove(TASK); await rm(repo, { recursive: true, force: true }); });

  const info = await mgr.create(TASK, RUN);
  await commitFile(info.path, 'feature.ts', 'export const answer = 42;\n', 'add feature');

  const diff = await mgr.harvest(TASK);
  assert.match(diff, /feature\.ts/);
  assert.match(diff, /\+export const answer = 42;/);
});

test('harvest() throws for an unknown task', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  t.after(() => rm(repo, { recursive: true, force: true }));

  await assert.rejects(() => mgr.harvest(makeTaskId('never-created')), /No worktree/);
});

test('remove() deletes the worktree directory, branch, and tracking entry', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  t.after(() => rm(repo, { recursive: true, force: true }));

  const info = await mgr.create(TASK, RUN);
  await mgr.remove(TASK);

  assert.equal(await exists(info.path), false, 'worktree dir should be gone');
  assert.equal(mgr.get(TASK), undefined);
  const branches = await git(['branch', '--list', info.branch], repo);
  assert.equal(branches, '', 'branch should be deleted');
});

test('remove() of an unknown task is a no-op', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  t.after(() => rm(repo, { recursive: true, force: true }));
  await assert.doesNotReject(() => mgr.remove(makeTaskId('ghost')));
});

test('get()/getAll() track live worktrees', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  const t2 = makeTaskId('t2');
  t.after(async () => {
    await mgr.remove(TASK); await mgr.remove(t2);
    await rm(repo, { recursive: true, force: true });
  });

  await mgr.create(TASK, RUN);
  await mgr.create(t2, RUN);
  assert.equal(mgr.getAll().length, 2);
  assert.equal(mgr.get(TASK)?.taskId, TASK);
  assert.equal(mgr.get(t2)?.taskId, t2);
});

test('pruneStale(0) removes every worktree', async (t) => {
  const repo = await makeRepo();
  const mgr = new WorktreeManager(repo);
  t.after(() => rm(repo, { recursive: true, force: true }));

  const info = await mgr.create(TASK, RUN);
  await new Promise((r) => setTimeout(r, 10)); // ensure createdAt is strictly in the past
  await mgr.pruneStale(0);
  assert.equal(mgr.getAll().length, 0);
  assert.equal(await exists(info.path), false);
});
