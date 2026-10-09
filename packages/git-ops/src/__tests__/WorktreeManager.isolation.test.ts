import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId } from '@maf/types';
import { RollbackManager, WorktreeManager, runIsolatedGit } from '../index.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

// ORACLE: D-03 — MAF never modifies the user's branch. Measured, not asserted in prose: a run's
// whole lifecycle leaves the user's HEAD, index, repository config, refs (bar the run's own
// branch) and every tracked, untracked and ignored file byte-identical.

/**
 * Everything about the user's checkout a run could disturb. Read with GIT_OPTIONAL_LOCKS=0
 * because a plain `git status` may rewrite the index to refresh its stat data — the test would
 * then be moving the very bytes it measures. The files git sees (tracked, untracked and ignored)
 * are copied into `snapshotDir` so the two states can be compared with `git diff --no-index`.
 * `runOwn` is exactly what a run adds — its worktree and the self-ignore file beside it — and
 * `runRef` its branch; nothing else may appear.
 */
async function userState(repo: string, snapshotDir: string, runOwn: readonly string[], runRef: string) {
  const read = async (args: string[]) =>
    (await runIsolatedGit(repo, args, { env: { GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  const list = async (args: string[]) => (await read([...args, '-z'])).split('\0').filter(Boolean).sort();
  const files = await list(['ls-files', '--cached', '--others', '--exclude-standard']);
  const ignored = (await list(['ls-files', '--others', '--ignored', '--exclude-standard'])).filter((f) => !runOwn.includes(f));
  for (const file of [...files, ...ignored]) {
    const target = path.join(snapshotDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repo, file)));
  }
  return {
    head:    await read(['rev-parse', 'HEAD']),
    headRef: await readFile(path.join(repo, '.git', 'HEAD'), 'utf8'),
    status:  await read(['status', '--porcelain=v1', '-z']),
    index:   await readFile(path.join(repo, '.git', 'index')),
    config:  await readFile(path.join(repo, '.git', 'config')),
    refs:    (await read(['for-each-ref', '--format=%(objectname) %(refname)'])).split('\n').filter((l) => l && !l.endsWith(` ${runRef}`)),
    files,
    ignored,
  };
}

const VARIANTS = [
  { label: 'that is clean', dirty: false, detached: false, sub: '' },
  { label: 'with staged, unstaged and untracked work in it', dirty: true, detached: false, sub: '' },
  { label: 'on a detached HEAD, with work in it', dirty: true, detached: true, sub: '' },
  { label: 'run from a subdirectory, with work in it', dirty: true, detached: false, sub: 'pkg/' },
] as const;

for (const { label, dirty, detached, sub } of VARIANTS) {
  test(`a run leaves a user checkout ${label} byte-identical: HEAD, index, config, refs and files`, async (t) => {
    const repo = await makeRepo('maf-isolation-');
    const snaps = await mkdtemp(path.join(tmpdir(), 'maf-isolation-snap-'));
    t.after(async () => {
      await rm(repo, { recursive: true, force: true });
      await rm(snaps, { recursive: true, force: true });
    });
    await commitFile(repo, '.gitignore', '*.log\n', 'ignore logs');
    if (sub) {
      await mkdir(path.join(repo, sub));
      await commitFile(repo, `${sub}a.txt`, 'a\n', 'add pkg');
    }
    await writeFile(path.join(repo, 'build.log'), 'ignored, but the user\'s\n', 'utf8');
    if (detached) await git(['checkout', '-q', '--detach'], repo);
    if (dirty) {
      await writeFile(path.join(repo, 'staged.txt'), 'staged by the user\n', 'utf8');
      await git(['add', 'staged.txt'], repo);
      await writeFile(path.join(repo, 'README.md'), '# edited, not staged\n', 'utf8');
      await writeFile(path.join(repo, 'untracked.txt'), 'never added\n', 'utf8');
    }
    const RUN = makeRunId('iso1');
    const runOwn = [`${sub}.maf/worktrees/.gitignore`, `${sub}.maf/worktrees/iso1/`];
    const before = await userState(repo, path.join(snaps, 'before'), runOwn, 'refs/heads/maf/iso1');

    // The representative sequence: create → work and commit in the worktree → a checkpoint and a
    // rollback there (what PatchTestCycle does on a red test) → finish(success).
    const worktrees = new WorktreeManager(path.join(repo, sub));
    const run = await worktrees.createForRun(RUN);
    await commitFile(run.cwd, 'feature.ts', 'export const answer = 42;\n', 'run work');
    const rollback = new RollbackManager(run.cwd, run);
    await rollback.checkpoint();
    await commitFile(run.cwd, 'feature.ts', 'export const answer = -1; // broken\n', 'bad attempt');
    await rollback.rollbackToLast();
    const result = await worktrees.finish(RUN, 'success');

    const after = await userState(repo, path.join(snaps, 'after'), runOwn, 'refs/heads/maf/iso1');
    assert.equal(after.head, before.head, 'HEAD did not move');
    assert.equal(after.headRef, before.headRef, detached ? 'HEAD is still detached at the same commit' : 'the checked-out branch did not change');
    assert.equal(after.status, before.status, 'git status is identical');
    if (!dirty) assert.equal(after.status, '', 'and empty for a clean checkout');
    assert.deepEqual(after.files, before.files, 'the same files are tracked or untracked');
    assert.deepEqual(after.ignored, before.ignored, 'the same files are ignored, bar the run\'s worktree');
    assert.ok(after.index.equals(before.index), "the user's index is byte-identical");
    assert.ok(after.config.equals(before.config), "the user's .git/config is byte-identical");
    assert.deepEqual(after.refs, before.refs, "no ref but the run's own branch was created, moved or deleted");
    const diff = await runIsolatedGit(snaps, ['diff', '--no-index', '--exit-code', 'before', 'after'])
      .then(() => '', (err: { stdout?: string }) => err.stdout ?? String(err));
    assert.equal(diff, '', 'every tracked, untracked and ignored file has the same bytes');

    // And the run's work is where the printed command will find it.
    assert.equal(result.kind === 'merge' ? result.mergeCommand : result.kind, 'git merge maf/iso1');
    assert.equal(await git(['show', `maf/iso1:${sub}feature.ts`], repo), 'export const answer = 42;');
  });
}
