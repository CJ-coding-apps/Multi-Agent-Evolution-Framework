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

// R3-G1 grew the corpus from 16 tasks to 56, so each iteration now runs ~86 s and five of them no
// longer fit the old 240 s budget: 425 s alone and 525 s in the serial suite on the recording host
// (188 s in the Linux container). R4-A3 grew it again, to 86 tasks: measured on the round-4 host,
// one iteration is 148 s, so five are ~740 s and the 900 s backstop sat within contention's reach
// (the second serial run hit it at 900.0 s with every other test green). R5-P1 grew the corpus to
// 116 tasks, so the measured cap is re-checked against the round-5 timing; the 1800 s cap is a
// backstop well above the measurement rather than a race.
test('five goldens stacks built, run and torn down in one process each reproduce the baseline, and the process lives', {
  skip: lcmLoads() || process.env['CI'] ? false : 'better-sqlite3 does not load on this host (CI runs this)',
  timeout: 1_800_000,
}, async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--iterations', '5'], { cwd: REPO, timeout: 1_800_000 }).catch(
    (e: { code?: number; signal?: string; stdout?: string; stderr?: string }) => assert.fail(
      `the stress process failed (${e.signal ?? `exit ${String(e.code)}`}): ${e.stdout ?? ''}${e.stderr ?? ''}`,
    ),
  );
  assert.match(stdout, /stress-native-lifecycle: 5\/5 iterations in one process/);
});
