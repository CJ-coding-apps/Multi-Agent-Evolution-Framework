import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId, makeTaskId } from '@maf/types';
import { WorktreeManager, resolveWorkingDir } from '../WorktreeManager.js';
import type { RunWorktree } from '../WorktreeManager.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

const RUN = makeRunId('r1');

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

test('createForRun() checks out .maf/worktrees/<runId> on a new maf/<runId> branch at the current HEAD', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const head = await git(['rev-parse', 'HEAD'], repo);

  const wt = await new WorktreeManager(repo).createForRun(RUN);

  assert.equal(wt.path, path.join(repo, '.maf', 'worktrees', 'r1'));
  assert.equal(wt.branch, 'maf/r1');
  assert.equal(wt.baseCommit, head);
  assert.equal(wt.cwd, wt.path, 'at the repository top the run works at the worktree root');
  assert.equal(await git(['rev-parse', '--show-toplevel'], wt.path), await realpath(wt.path), 'it is a worktree of its own');
  assert.equal(await git(['symbolic-ref', 'HEAD'], wt.path), 'refs/heads/maf/r1');
  assert.equal(await git(['rev-parse', 'HEAD'], wt.path), head);
  assert.equal(await git(['symbolic-ref', 'HEAD'], repo), 'refs/heads/main', "the user's checkout stays on its branch");
});

test('createForRun() refuses a repository with no commits, and says so', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'maf-git-unborn-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(['init', '-q'], repo);

  await assert.rejects(() => new WorktreeManager(repo).createForRun(RUN), /has no commits yet.*--no-worktree/s);
  assert.equal(await exists(path.join(repo, '.maf')), false, 'nothing was created');
});

test('createForRun() refuses when the branch maf/<runId> already exists', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(['branch', 'maf/r1'], repo);

  await assert.rejects(() => new WorktreeManager(repo).createForRun(RUN), /branch maf\/r1 already exists/);
  assert.equal(await exists(path.join(repo, '.maf', 'worktrees', 'r1')), false);
});

test('createForRun() refuses a run id that is not safe as both a branch and a directory name', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);

  for (const bad of ['../escape', 'a/b', '', '-x', 'a b', 'x.lock', 'x'.repeat(129)]) {
    await assert.rejects(() => mgr.createForRun(makeRunId(bad)), /expected a run id/, JSON.stringify(bad));
  }
  assert.equal(await exists(path.join(repo, '.maf')), false);
});

test('createForRun() refuses a directory that is not in a git repository', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-git-none-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => new WorktreeManager(dir).createForRun(RUN), /not inside a git repository/);
});

test('createForRun() from a subdirectory: the run works in the same subdirectory of its worktree', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(path.join(repo, 'pkg'));
  await commitFile(repo, 'pkg/a.txt', 'a\n', 'add pkg');

  const wt = await new WorktreeManager(path.join(repo, 'pkg')).createForRun(RUN);

  assert.equal(wt.path, path.join(repo, 'pkg', '.maf', 'worktrees', 'r1'));
  assert.equal(wt.cwd, path.join(wt.path, 'pkg'));
  assert.equal(await readFile(path.join(wt.cwd, 'a.txt'), 'utf8'), 'a\n');
});

test('finish(success) returns the merge command and does not merge', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await commitFile(wt.cwd, 'feature.txt', 'done\n', 'run work');
  const userHead = await git(['rev-parse', 'HEAD'], repo);

  const result = await mgr.finish(RUN, 'success');

  assert.deepEqual(result, { outcome: 'success', mergeCommand: 'git merge maf/r1', path: wt.path, branch: 'maf/r1' });
  assert.equal(await git(['rev-parse', 'HEAD'], repo), userHead, 'nothing was merged into the user branch');
  assert.equal(await exists(path.join(repo, 'feature.txt')), false);
  assert.ok(await exists(wt.path), 'the worktree is not removed unasked');
  assert.notEqual(await git(['branch', '--list', 'maf/r1'], repo), '', 'nor is the branch');
});

test('finish(success) commits work the run left uncommitted, so the merge command carries it', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'loose.txt'), 'written, never committed\n', 'utf8');
  // Runtime state is never part of the run's result, exactly as it is never part of the reviewed diff.
  await mkdir(path.join(wt.cwd, '.maf', 'transcripts'), { recursive: true });
  await writeFile(path.join(wt.cwd, '.maf', 'transcripts', 'run.jsonl'), '{}\n', 'utf8');

  await mgr.finish(RUN, 'success');

  assert.equal(await git(['show', 'maf/r1:loose.txt'], repo), 'written, never committed');
  assert.equal(await git(['ls-tree', '-r', '--name-only', 'maf/r1', '--', '.maf'], repo), '', 'runtime state was not committed');
  await git(['merge', '--ff-only', 'maf/r1'], repo);
  assert.equal(await readFile(path.join(repo, 'loose.txt'), 'utf8'), 'written, never committed\n', 'the printed command brings the work in');
});

test('finish(failure) keeps the worktree exactly as the run left it and returns its path', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'half.txt'), 'half-done\n', 'utf8');

  const result = await mgr.finish(RUN, 'failure');

  assert.deepEqual(result, { outcome: 'failure', path: wt.path, branch: 'maf/r1' });
  assert.equal(await readFile(path.join(wt.cwd, 'half.txt'), 'utf8'), 'half-done\n');
  assert.equal(await git(['rev-parse', 'maf/r1'], repo), wt.baseCommit, 'nothing was committed on failure');
});

test('remove() deletes the worktree and its branch — and only remove() does', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'leftover.txt'), 'uncommitted\n', 'utf8');
  await mgr.finish(RUN, 'failure');
  assert.ok(await exists(wt.path));

  await mgr.remove(RUN);

  assert.equal(await exists(wt.path), false, 'worktree directory is gone');
  assert.equal(await git(['branch', '--list', 'maf/r1'], repo), '', 'branch is gone');
  assert.doesNotMatch(await git(['worktree', 'list'], repo), /worktrees\/r1/, "git's record of it is gone");
});

test("harvest() returns the run's whole change, committed or not (kept for ReviewGate, its one caller)", async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await commitFile(wt.cwd, 'committed.ts', 'export const a = 1;\n', 'agent commit');
  await writeFile(path.join(wt.cwd, 'loose.ts'), 'export const b = 2;\n', 'utf8');

  const diff = await mgr.harvest(makeTaskId('any'));
  assert.match(diff, /\+export const a = 1;/);
  assert.match(diff, /\+export const b = 2;/);
});

test('the per-task worktree API is gone: one worktree per run (D-03)', () => {
  // Nothing called create(taskId, runId), get, getAll or pruneStale; the whole-repo typecheck is
  // what proves it, and this keeps them from coming back.
  const proto = WorktreeManager.prototype as unknown as Record<string, unknown>;
  for (const name of ['create', 'get', 'getAll', 'pruneStale']) assert.equal(proto[name], undefined, name);
});

// ── resolveWorkingDir: the --no-worktree decision, as a pure function ────────────────────

const RUN_WT: RunWorktree = {
  runId: RUN, path: '/repo/.maf/worktrees/r1', branch: 'maf/r1', baseCommit: 'a'.repeat(40),
  cwd: '/repo/.maf/worktrees/r1/sub',
};

test('resolveWorkingDir: by default the run works in its worktree, with no warning', () => {
  assert.deepEqual(resolveWorkingDir({ dir: '/repo/sub', worktree: true, run: RUN_WT }), { cwd: RUN_WT.cwd, isolated: true });
});

test('resolveWorkingDir: --no-worktree runs in place, not isolated, and warns', () => {
  const d = resolveWorkingDir({ dir: '/repo/sub', worktree: false });
  assert.equal(d.cwd, path.resolve('/repo/sub'));
  assert.equal(d.isolated, false);
  assert.match(d.warning ?? '', /in place/);
  assert.match(d.warning ?? '', /rollbacks are disabled/);
});

test('resolveWorkingDir: a contradiction is an error, not a guess', () => {
  assert.throws(() => resolveWorkingDir({ dir: '/repo', worktree: true }), /createForRun/);
  assert.throws(() => resolveWorkingDir({ dir: '/repo', worktree: false, run: RUN_WT }), /--no-worktree/);
});
