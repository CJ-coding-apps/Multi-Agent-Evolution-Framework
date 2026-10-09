import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { ScriptedAdapter } from '@maf/eval-harness';
import { WorktreeManager, runIsolatedGit } from '@maf/git-ops';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import {
  FIXED_SUM, driveRun, lockFilePolicy, messageOf, needsLcm, registryOf, userState,
} from './runFixture.js';

// ORACLE: rule 4 (WP-2.4, D-03, D-35) — how a run hands its work over. With isolation off in
// config.yaml it works in place after a warning that names the file, not a flag nobody typed, and
// offers no merge; with isolation on, a branch that commits MAF runtime state — content the security
// gate's diff leaves out (D-29) — gets no merge command, names the paths, and the run exits non-zero
// although every node succeeded. So does a run whose `finish` throws: its work never reached the
// branch, and exit 0 would tell CI it had (verifier F2).

const TASK = 'Fix the bug in sum.js';
const headless = () => ({ stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'handover-key' } });

async function withRepo(body: (root: string, repo: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-handover-'));
  try {
    await body(root, await createDemoFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('worktree: false in config.yaml runs in place after a warning, and offers no merge', needsLcm, async () => {
  await withRepo(async (root, repo) => {
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'config.yaml'), 'worktree: false\n', 'utf8');
    // Committed, so the tree is clean and the run has nothing of the user's to warn about.
    await runIsolatedGit(repo, ['add', '.maf/config.yaml']);
    await runIsolatedGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'config']);
    const scripted = new ScriptedAdapter([{ prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--policy', await lockFilePolicy(root)],
      { adapters: registryOf(scripted), io: headless() });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    assert.ok(run.err.includes(`[maf] warning: worktree isolation is off (worktree: false in .maf/config.yaml): this run edits ${repo} in place`), run.err);
    assert.doesNotMatch(run.err, /--no-worktree/, 'no flag the user did not type is named');
    assert.doesNotMatch(run.err, /uncommitted/, 'a clean tree gives the gates nothing of the user\'s to see');
    assert.equal(await readFile(path.join(repo, 'sum.js'), 'utf8'), FIXED_SUM, 'the change is in the directory itself');
    await assert.rejects(access(path.join(repo, '.maf', 'worktrees')), 'no worktree was created');
    assert.equal((await runIsolatedGit(repo, ['branch', '--list', 'maf/*'])).stdout.trim(), '');
    assert.doesNotMatch(run.out + run.err, /git merge|\[maf\] worktree:/);
  });
});

test('a run branch that commits MAF runtime state is refused a merge, naming the path, and the run exits non-zero', needsLcm, async () => {
  await withRepo(async (root, repo) => {
    // A project that commits something under .maf/, so the run's worktree has the directory.
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'NOTES.md'), 'project notes\n', 'utf8');
    await runIsolatedGit(repo, ['add', '.maf/NOTES.md']);
    await runIsolatedGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'notes']);
    const before = await userState(repo);
    const scripted = new ScriptedAdapter([{ prompt: TASK, final: 'done', steps: [
      { tool: 'fs.write', input: { path: '.maf/lcm.db', content: 'not a database: whatever the next run loads from here\n' } },
      { tool: 'git.add', input: { paths: ['.maf/lcm.db'] } },
      { tool: 'git.commit', input: { message: 'add state' } },
    ] }]);
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--policy', await lockFilePolicy(root)],
      { adapters: registryOf(scripted), io: headless() });
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const worktree = path.join(repo, '.maf', 'worktrees', runId);
    assert.match(messageOf(run.error), new RegExp(`run ${runId} succeeded, but maf/${runId} commits MAF runtime state \\(\\.maf/lcm\\.db\\), so no merge is offered`));
    assert.ok(run.err.includes(`[maf] not offering a merge: maf/${runId} commits MAF runtime state the security gate never reviews: .maf/lcm.db; inspect ${worktree}`), run.err);
    assert.doesNotMatch(run.out + run.err, /git merge/);
    assert.match(run.out, /← node \S+ Succeeded/, 'every node succeeded; only the hand-over is refused');
    assert.deepEqual(await userState(repo), before, 'the user is untouched');
  });
});

test('a successful run whose worktree cannot be finished exits non-zero, saying where the work is', needsLcm, async (t) => {
  await withRepo(async (root, repo) => {
    t.mock.method(WorktreeManager.prototype, 'finish', async () => {
      throw new Error('simulated: the worktree\'s HEAD is detached');
    });
    const scripted = new ScriptedAdapter([{ prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--policy', await lockFilePolicy(root)],
      { adapters: registryOf(scripted), io: headless() });
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const worktree = path.join(repo, '.maf', 'worktrees', runId);
    assert.match(run.out, /← node \S+ Succeeded/, 'every node succeeded');
    assert.equal(messageOf(run.error),
      `run ${runId} succeeded, but its work is on maf/${runId} at ${worktree} and could not be finished: simulated: the worktree's HEAD is detached`);
    assert.ok(run.err.includes(`[maf] the run's worktree is kept at ${worktree} (branch maf/${runId}).`), run.err);
    assert.doesNotMatch(run.out + run.err, /git merge/);
    assert.equal(await readFile(path.join(worktree, 'sum.js'), 'utf8'), FIXED_SUM, 'the work is where the message says');
  });
});
