import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { CliAdapter } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { onePlannedNode, FIXED_SUM, driveRun, lockFilePolicy, needsLcm, recording, registryOf } from './runFixture.js';

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
