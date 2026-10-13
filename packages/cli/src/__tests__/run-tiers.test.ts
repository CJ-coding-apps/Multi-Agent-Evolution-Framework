import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScriptedAdapter } from '@maf/eval-harness';
import { cliOnlyAdapter, driveRun, messageOf, registryOf } from './runFixture.js';

// ORACLE: WP-2.1 integration (rule 5, D-01) — a writer role that would run on the cli tier, outside
// MAF's gates, is refused before planning unless the operator passes --allow-ungoverned. The
// dispatcher would refuse the node later anyway; refusing first spends no planner tokens and
// checks out no worktree.

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-run-tiers-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('on an adapter that cannot run the loop, the built-in writers are refused before planning', async () => {
  await withDir(async (dir) => {
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'cli-only'], { adapters: registryOf(cliOnlyAdapter('cli-only')) });
    const message = messageOf(run.error);
    assert.match(message, /writer role\(s\) coder \(adapter cli-only cannot run the in-process loop\)/);
    assert.match(message, /Pass --allow-ungoverned/);
    assert.doesNotMatch(run.out, /planning/, 'the planner was never asked');
    assert.ok(!(await readdir(path.join(dir, '.maf'))).includes('worktrees'), 'no worktree was checked out');
  });
});

test('a writer whose execution is cli is named as such', async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, 'roles.yaml'), [
      'version: 1', 'defaultRole: coder', 'roles:',
      '  - { role: coder, systemPrompt: c, allowedTools: [fs.read, fs.write], execution: cli }',
      '  - { role: reader, systemPrompt: r, allowedTools: [fs.read], execution: cli }', '',
    ].join('\n'), 'utf8');
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted', '--roles', 'roles.yaml'],
      { adapters: registryOf(new ScriptedAdapter()) });
    assert.match(messageOf(run.error), /writer role\(s\) coder \(its execution is cli\) would run on the cli tier/);
    assert.doesNotMatch(messageOf(run.error), /reader/, 'a reader on the cli tier is not ungoverned');
  });
});

test('--allow-ungoverned lets the run past the check, to the next step', async () => {
  await withDir(async (dir) => {
    // Not a repository, so with the check passed the run stops at the worktree — before any model call.
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'cli-only', '--allow-ungoverned'],
      { adapters: registryOf(cliOnlyAdapter('cli-only')) });
    assert.doesNotMatch(messageOf(run.error), /would run on the cli tier/);
    assert.match(messageOf(run.error), /is not inside a git repository/);
  });
});
