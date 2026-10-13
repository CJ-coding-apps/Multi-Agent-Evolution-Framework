import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { LcmEngine } from '@maf/lcm';

// ORACLE (WP-2.15): `goldens run` builds and tears down a stack holding both native stores — the
// evaluation's Kùzu graph and better-sqlite3 LCM store — then opens the project's graph, all in one
// process. Repeated in one process with garbage collected between runs, every run must reproduce
// the committed baseline and the process must live: a kuzu result that outlived its database used
// to corrupt the heap there. scripts/stress-native-lifecycle.mjs runs the same loop, 20 by default.

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/stress-native-lifecycle.mjs');

/** As in goldens-offline.test.ts: a host whose better-sqlite3 does not load skips, but never under CI. */
function lcmLoads(): boolean {
  try {
    new LcmEngine({ dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward', summarize: async () => '' }).close();
    return true;
  } catch {
    return false;
  }
}

test('five goldens stacks built, run and torn down in one process each reproduce the baseline, and the process lives', {
  skip: lcmLoads() || process.env['CI'] ? false : 'better-sqlite3 does not load on this host (CI runs this)',
  timeout: 240_000,
}, async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--iterations', '5'], { cwd: REPO, timeout: 240_000 }).catch(
    (e: { code?: number; signal?: string; stdout?: string; stderr?: string }) => assert.fail(
      `the stress process failed (${e.signal ?? `exit ${String(e.code)}`}): ${e.stdout ?? ''}${e.stderr ?? ''}`,
    ),
  );
  assert.match(stdout, /stress-native-lifecycle: 5\/5 iterations in one process/);
});
