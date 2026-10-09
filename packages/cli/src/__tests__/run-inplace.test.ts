import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { ScriptedAdapter } from '@maf/eval-harness';
import { runIsolatedGit } from '@maf/git-ops';
import {
  onePlannedNode,
  FIXED_SUM, dirtyUserRepo, driveRun, lockFilePolicy, messageOf, needsLcm, registryOf, userState,
} from './runFixture.js';

// ORACLE: verifier F4 (M20), F8 and F11 — a typed `--no-worktree` beats a config file saying
// `worktree: true`. With isolation off the gates diff the user's own directory, so on a tree with
// uncommitted work the run says, once, that the security gate will take that work for the run's
// change and that a refusal leaves it in place; `--review` there is refused before anything runs,
// since a reviewer could not tell the user's edits from the agent's. Every warning names what the
// user did (`--no-worktree`), not the config file that said otherwise.

const TASK = 'Fix the bug in sum.js';
const headless = () => ({ stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'inplace-key' } });

async function withDirtyRepo(body: (root: string, repo: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-inplace-'));
  try {
    const repo = await dirtyUserRepo(root);
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'config.yaml'), 'worktree: true\n', 'utf8');
    await body(root, repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a typed --no-worktree beats worktree: true in config.yaml; on a dirty tree the run warns once what the gate will see', needsLcm, async () => {
  await withDirtyRepo(async (root, repo) => {
    const scripted = new ScriptedAdapter([onePlannedNode(TASK), { prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--no-worktree', '--policy', await lockFilePolicy(root)],
      { adapters: registryOf(scripted), io: headless() });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);

    // In place, as typed: the change is in the directory, no worktree, no branch, no merge.
    assert.equal(await readFile(path.join(repo, 'sum.js'), 'utf8'), FIXED_SUM);
    await assert.rejects(access(path.join(repo, '.maf', 'worktrees')), 'no worktree was created');
    assert.equal((await runIsolatedGit(repo, ['branch', '--list', 'maf/*'])).stdout.trim(), '');
    assert.doesNotMatch(run.out + run.err, /git merge|\[maf\] worktree:/);

    assert.ok(run.err.includes(`[maf] warning: worktree isolation is off (--no-worktree): this run edits ${repo} in place`), run.err);
    const dirty = run.err.split('\n').filter((l) => l.includes('has uncommitted or untracked changes'));
    assert.deepEqual(dirty, [
      `[maf] warning: ${repo} has uncommitted or untracked changes and worktree isolation is off (--no-worktree): ` +
      'the security gate will see them as the run\'s own change, and a refused change is left in place, yours with it (rollbacks are off).',
    ]);
    assert.doesNotMatch(run.err, /config\.yaml/, 'the flag the user typed is named, not the file it overrode');
  });
});

test('--review on a dirty tree with isolation off is refused before anything runs', async () => {
  await withDirtyRepo(async (root, repo) => {
    const before = await userState(repo);
    const scripted = new ScriptedAdapter();
    const asked: unknown[] = [];
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--no-worktree', '--review', '--policy', await lockFilePolicy(root)], {
      adapters: registryOf(scripted), io: headless(), reviewer: async (request) => { asked.push(request); throw new Error('never asked'); },
    });
    assert.equal(messageOf(run.error),
      `--review was given, but worktree isolation is off (--no-worktree) and ${repo} has uncommitted or untracked changes: ` +
      'the reviewer would be shown them as the run\'s own change, and a denial could not undo them. Commit them first, or run with worktree isolation on.');
    assert.equal(scripted.exchanges.length, 0, 'no model was asked anything');
    assert.equal(asked.length, 0);
    const state = await readdir(path.join(repo, '.maf'));
    for (const store of ['memory.kuzu', 'lcm.db', 'attestations', 'transcripts', 'worktrees']) {
      assert.ok(!state.includes(store), `no ${store} (found: ${state.join(', ')})`);
    }
    assert.deepEqual(await userState(repo), before, 'the user\'s files, status, index, HEAD and config are as they were');
  });
});
