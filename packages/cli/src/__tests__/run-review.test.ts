import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { HarnessStore, mintHarnessConfig } from '@maf/harness-config';
import { ScriptedAdapter } from '@maf/eval-harness';
import { driveRun, messageOf, registryOf } from './runFixture.js';

// ORACLE: D-34 / rule 6 — the review gate exists only when asked for. `--review` with no one to ask
// says so in one line and runs without a gate (advisory cannot be honoured); a harness that requires
// review, run headless, gets no gate either, so every writer change is refused — and the run says
// that before it starts. Each run here stops at the worktree step (the directory is no repository),
// after the review decision and before any model call.

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-run-review-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const headless = (env: NodeJS.ProcessEnv = {}, isTTY = false) => ({ stdin: new PassThrough(), isTTY, env });

test('--review with no terminal prints one line and runs without a gate', async () => {
  await withDir(async (dir) => {
    for (const [io, why] of [[headless(), /stdin is not a terminal/], [headless({ MAF_HEADLESS: '1' }, true), /MAF_HEADLESS=1/]] as const) {
      const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted', '--review'],
        { adapters: registryOf(new ScriptedAdapter()), io });
      const lines = run.err.split('\n').filter((l) => l.includes('--review'));
      assert.equal(lines.length, 1, run.err);
      assert.match(lines[0] ?? '', /--review was given, but no reviewer is available \(.*\); running without a review gate\./);
      assert.match(lines[0] ?? '', why);
      assert.match(messageOf(run.error), /is not inside a git repository/, 'the run went on, past the review decision');
    }
  });
});

test('a harness that requires review, run headless, is told every writer change will be refused', async () => {
  await withDir(async (dir) => {
    const store = new HarnessStore(path.join(dir, '.maf'));
    const strict = mintHarnessConfig({
      id: 'strict', processorBundles: [], reviewGate: { required: true },
      roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: 'c', allowedTools: ['fs.read', 'fs.write'] }] },
    });
    await store.save(strict);
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted', '--harness', 'strict'],
      { adapters: registryOf(new ScriptedAdapter()), io: headless() });
    assert.match(run.err, /harness strict requires review and no reviewer is available \(stdin is not a terminal.*\); every writer change will be refused \(D-34\)\./);
  });
});

test('with neither --review nor a harness that requires it, nothing about review is said or asked', async () => {
  await withDir(async (dir) => {
    const run = await driveRun(['fix it', '--dir', dir, '--adapter', 'scripted'],
      { adapters: registryOf(new ScriptedAdapter()), io: headless(), reviewer: async () => { throw new Error('never asked'); } });
    assert.doesNotMatch(run.err, /review/i);
  });
});
