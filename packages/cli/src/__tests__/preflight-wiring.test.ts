import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { CliAdapter } from '@maf/types';
import { ClaudeAdapter } from '@maf/adapter-claude';
import { ScriptedAdapter } from '@maf/eval-harness';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import {
  onePlannedNode, FIXED_SUM, driveRun, lockFilePolicy, messageOf, needsLcm, recording, registryOf,
} from './runFixture.js';

// ORACLE (WP-3.9 F5): `preflight()` is only worth having if `maf run` calls it — once, and before
// the planner spends a call on a backend it has not checked. The adapter below records how many
// adapter calls had happened when it was asked, which is the order the brief names.

const TASK = 'Fix the bug in sum.js';
const headless = () => ({ stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'preflight-key' } });

async function withRepo(body: (root: string, repo: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-preflight-run-'));
  try {
    await body(root, await createDemoFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('run preflights the claude adapter once, before it plans (WP-3.9 F5)', needsLcm, async () => {
  await withRepo(async (root, repo) => {
    const scripted = new ScriptedAdapter([
      onePlannedNode(TASK),
      { prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] },
    ]);
    const { adapter, calls } = recording(scripted);
    // What the adapter had been asked when preflight ran: 0 means "before the planner's call".
    const callsBeforePreflight: number[] = [];
    const claude: CliAdapter = {
      ...adapter,
      name: 'claude',
      preflight: async () => { callsBeforePreflight.push(calls.length); },
    };

    const run = await driveRun([TASK, '--adapter', 'claude', '--dir', repo, '--policy', await lockFilePolicy(root)], {
      adapters: registryOf(claude),
      io: headless(),
    });

    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    assert.deepEqual(callsBeforePreflight, [0], 'asked exactly once, before any adapter call');
    assert.ok(calls.length > 0, 'and the run went on to plan and execute');
    assert.match(run.out, /\[maf\] planning\.\.\./);
  });
});

test('a refused preflight stops `maf run` before it plans or opens a store (WP-3.9 G7)', async () => {
  // The real ClaudeAdapter against a stand-in binary: this is the sentence a user reads, from the
  // real resolution and the two real probes, not a stubbed `preflight()` that throws.
  if (process.platform === 'win32') return; // shell-script fixture
  await withRepo(async (root, repo) => {
    const binDir = path.join(root, 'bin');
    const asked = path.join(root, 'asked.txt');
    await mkdir(binDir);
    const binary = path.join(binDir, 'claude');
    await writeFile(binary, [
      '#!/bin/sh',
      `printf '%s\\n' "$1" >> '${asked}'`,
      'case "$1" in',
      "  --version) printf '%s\\n' '0.1.0 (Claude Code)' ;;",
      // A CLI that does not know --tools: every governed turn and both isolated cli-tier sets
      // pass it, so every node would have exited 1.
      "  --help) printf '%s\\n' 'Usage: claude [options]' '  --print  Print response and exit' ;;",
      "  *) printf 'ok\\n' ;;",
      'esac',
      '',
    ].join('\n'));
    await chmod(binary, 0o755);

    const savedPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    try {
      const run = await driveRun([TASK, '--adapter', 'claude', '--dir', repo], {
        adapters: registryOf(new ClaudeAdapter()), io: headless(),
      });

      // `driveRun` records what main.ts throws, and main.ts answers a throw with exit 1 and
      // `[maf] error: <message>`. The message is what the user sees; the exit code follows.
      assert.ok(run.error, '`maf run` failed rather than going on');
      const message = messageOf(run.error);
      assert.match(message, /does not support --tools/, 'the preflight sentence, not a node failure');
      assert.ok(message.includes(binary), `and it names the binary that answered: ${message}`);
      assert.match(message, /version 0\.1\.0/, 'and the version it found');

      // Only the availability question and the two probes reached the backend: the planner's argv
      // (`--print …`) never did, so no model call was paid for.
      assert.deepEqual((await readFile(asked, 'utf8')).trim().split('\n'), ['--version', '--version', '--help'],
        'exactly the availability check and the two preflight probes — no planner call');
      // And nothing was opened: the harness store is the first store the run would create.
      await assert.rejects(lstat(path.join(repo, '.maf', 'harnesses')), { code: 'ENOENT' },
        'the harness store was never opened');
      await assert.rejects(lstat(path.join(repo, '.maf', 'worktrees')), { code: 'ENOENT' },
        'and no worktree was made');
    } finally {
      process.env['PATH'] = savedPath;
    }
  });
});
