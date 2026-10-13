import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runIsolatedGit } from '@maf/git-ops';
import { ScriptedAdapter } from '@maf/eval-harness';
import { driveRun, messageOf, registryOf } from './runFixture.js';

// ORACLE: WP-2.4 integration (rule 4, D-03) — a run that cannot get its own worktree ends with the
// reason before any agent work: no model call, no store opened, nothing left behind. It never
// falls back to the user's checkout.

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-worktree-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const git = (cwd: string, ...args: string[]) => runIsolatedGit(cwd, args);

async function nothingRan(dir: string, scripted: ScriptedAdapter): Promise<void> {
  assert.equal(scripted.exchanges.length, 0, 'the adapter was never asked anything');
  const state = await readdir(path.join(dir, '.maf'));
  for (const store of ['memory.kuzu', 'lcm.db', 'attestations', 'transcripts']) {
    assert.ok(!state.includes(store), `no ${store} was opened (found: ${state.join(', ')})`);
  }
}

test('a repository with no commits is refused before any agent work, naming --no-worktree', async () => {
  await withRoot(async (dir) => {
    await git(dir, 'init', '-q');
    await writeFile(path.join(dir, 'a.txt'), 'uncommitted\n', 'utf8');
    const scripted = new ScriptedAdapter();
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted'], { adapters: registryOf(scripted) });
    assert.match(messageOf(run.error), /has no commits yet.*--no-worktree/s);
    await nothingRan(dir, scripted);
  });
});

test('a directory with no committed files is refused, and the worktree and branch it began are gone', async () => {
  await withRoot(async (root) => {
    await git(root, 'init', '-q');
    await writeFile(path.join(root, 'tracked.txt'), 'x\n', 'utf8');
    await git(root, 'add', '-A');
    await git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
    const dir = path.join(root, 'untracked-project');
    await mkdir(dir);
    await writeFile(path.join(dir, 'new.txt'), 'never committed\n', 'utf8');

    const scripted = new ScriptedAdapter();
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted'], { adapters: registryOf(scripted) });
    assert.match(messageOf(run.error), /has no committed files; commit it or run with --no-worktree/);
    await nothingRan(dir, scripted);
    assert.equal((await git(root, 'branch', '--list', 'maf/*')).stdout.trim(), '', 'no run branch is left');
    assert.equal((await git(root, 'worktree', 'list', '--porcelain')).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  });
});

test('a directory outside any repository is refused while worktree isolation is on', async () => {
  await withRoot(async (dir) => {
    // A config file turning isolation on explicitly, so the refusal is not a default's accident.
    await mkdir(path.join(dir, '.maf'));
    await writeFile(path.join(dir, '.maf', 'config.yaml'), 'worktree: true\n', 'utf8');
    const scripted = new ScriptedAdapter();
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted'], { adapters: registryOf(scripted) });
    assert.match(messageOf(run.error), /is not inside a git repository.*--no-worktree/s);
    await nothingRan(dir, scripted);
    await assert.rejects(access(path.join(dir, '.maf', 'worktrees')), 'nothing was checked out');
  });
});
