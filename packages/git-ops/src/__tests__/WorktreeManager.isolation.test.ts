import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId } from '@maf/types';
import { RollbackManager, WorktreeManager, runIsolatedGit } from '../index.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

// ORACLE: D-03 — MAF never modifies the user's branch. Measured, not asserted in prose: a run's
// whole lifecycle leaves the user's HEAD, branch, index and every tracked and untracked file
// byte-identical.

/**
 * Everything about the user's checkout a run could disturb. Read with GIT_OPTIONAL_LOCKS=0
 * because a plain `git status` may rewrite the index to refresh its stat data — the test would
 * then be moving the very bytes it measures. The files git sees (tracked and untracked, not
 * ignored) are copied into `snapshotDir` so the two states can be compared with
 * `git diff --no-index`.
 */
async function userState(repo: string, snapshotDir: string) {
  const read = async (args: string[]) =>
    (await runIsolatedGit(repo, args, { env: { GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  const files = (await read(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0').filter(Boolean).sort();
  for (const file of files) {
    const target = path.join(snapshotDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repo, file)));
  }
  return {
    head:   await read(['rev-parse', 'HEAD']),
    branch: await read(['symbolic-ref', 'HEAD']),
    status: await read(['status', '--porcelain=v1', '-z']),
    index:  await readFile(path.join(repo, '.git', 'index')),
    files,
  };
}

for (const dirty of [false, true]) {
  const label = dirty ? 'with staged, unstaged and untracked work in it' : 'that is clean';
  test(`a run leaves a user checkout ${label} byte-identical: HEAD, branch, index and files`, async (t) => {
    const repo = await makeRepo('maf-isolation-');
    const snaps = await mkdtemp(path.join(tmpdir(), 'maf-isolation-snap-'));
    t.after(async () => {
      await rm(repo, { recursive: true, force: true });
      await rm(snaps, { recursive: true, force: true });
    });
    if (dirty) {
      await writeFile(path.join(repo, 'staged.txt'), 'staged by the user\n', 'utf8');
      await git(['add', 'staged.txt'], repo);
      await writeFile(path.join(repo, 'README.md'), '# edited, not staged\n', 'utf8');
      await writeFile(path.join(repo, 'untracked.txt'), 'never added\n', 'utf8');
    }
    const before = await userState(repo, path.join(snaps, 'before'));

    // The representative sequence: create → work and commit in the worktree → a checkpoint and a
    // rollback there (what PatchTestCycle does on a red test) → finish(success).
    const RUN = makeRunId('iso1');
    const worktrees = new WorktreeManager(repo);
    const run = await worktrees.createForRun(RUN);
    await commitFile(run.cwd, 'feature.ts', 'export const answer = 42;\n', 'run work');
    const rollback = new RollbackManager(run.cwd, run);
    await rollback.checkpoint();
    await commitFile(run.cwd, 'feature.ts', 'export const answer = -1; // broken\n', 'bad attempt');
    await rollback.rollbackToLast();
    const result = await worktrees.finish(RUN, 'success');

    const after = await userState(repo, path.join(snaps, 'after'));
    assert.equal(after.head, before.head, 'HEAD did not move');
    assert.equal(after.branch, before.branch, 'the checked-out branch did not change');
    assert.equal(after.status, before.status, 'git status is identical');
    if (!dirty) assert.equal(after.status, '', 'and empty for a clean checkout');
    assert.deepEqual(after.files, before.files, 'the same files are tracked or untracked');
    assert.ok(after.index.equals(before.index), "the user's index is byte-identical");
    const diff = await runIsolatedGit(snaps, ['diff', '--no-index', '--exit-code', 'before', 'after'])
      .then(() => '', (err: { stdout?: string }) => err.stdout ?? String(err));
    assert.equal(diff, '', 'every tracked and untracked file has the same bytes');

    // And the run's work is where the printed command will find it.
    assert.equal(result.outcome === 'success' ? result.mergeCommand : result.outcome, 'git merge maf/iso1');
    assert.equal(await git(['show', 'maf/iso1:feature.ts'], repo), 'export const answer = 42;');
  });
}
