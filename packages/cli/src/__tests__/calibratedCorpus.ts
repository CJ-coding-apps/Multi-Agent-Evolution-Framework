import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CALIBRATION_RULE, selectCalibrated, signCalibration } from '@maf/eval-harness';
import type { CalibrationUsage } from '@maf/eval-harness';
import { DEV_SIGNING_KEY } from '@maf/attestation';

/**
 * R7-L3: `maf evolve`'s held-out gate refuses a measurement signed with the public development
 * key, so a fixture that wants the gate to reach its own subject must sign with a key of its own.
 * This is a test key, exported to the process so `loadSplits` verifies under it and names it `env`.
 */
const TEST_SIGNING_KEY = 'wp-3.7b-test-signing-key';

/**
 * R5-P3 test fixture: give a corpus the calibration record its `heldOut` must be derived from.
 *
 * `loadSplits` recomputes the held-out selection from `calibration.json` and refuses a split whose
 * `heldOut` is not what the counts and rule produce, and `evolve` refuses a split with no
 * calibration behind it at all. A test corpus that predates a paid calibration therefore needs a
 * record to exercise the gate. The counts here are synthetic — one pass in three for every
 * held-out task — and marked by their `harnessId`; the repository's own `calibration.json` is a
 * measurement, and this helper is never used to write into it. `opts.usage` and `opts.adapter` let a
 * test state what the measurement cost and which adapter produced it (R5-P4's projection).
 */
export async function calibrateSplitForTest(
  corpusRoot: string,
  opts: { usage?: CalibrationUsage; adapter?: string; keySource?: 'env' | 'dev' } = {},
): Promise<void> {
  const splitsPath = path.join(corpusRoot, 'splits.json');
  const splits = JSON.parse(await readFile(splitsPath, 'utf8')) as {
    heldOut: string[];
    preRegistration: Record<string, unknown>;
  };
  const counts = splits.heldOut.map((taskId) => ({ taskId, passes: 1, attempts: 3 }));
  // R6-L2: `loadSplits` refuses an unsigned measurement. R7-L3: it also has to be signed with a key
  // of the fixture's own, because `maf evolve`'s gate refuses a dev-signed record; the key is
  // exported to the process so the loader verifies under the same one. `keySource: 'dev'` is for
  // the one test that proves the refusal.
  if (opts.keySource !== 'dev') process.env['MAF_SIGNING_KEY'] ??= TEST_SIGNING_KEY;
  const signing = opts.keySource === 'dev'
    ? { secret: DEV_SIGNING_KEY }
    : { secret: process.env['MAF_SIGNING_KEY'] };
  const record = signCalibration({
    version: 1, harnessId: 'test-fixture', harnessSha: 'a'.repeat(64),
    adapter: opts.adapter ?? 'scripted', runs: 3,
    ranAt: '2026-11-13T00:00:00.000Z', splitsSha: 'test-fixture', rule: CALIBRATION_RULE,
    tasks: counts, errors: [], selection: selectCalibrated(counts),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  }, signing);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path.join(corpusRoot, 'calibration.json'), text, 'utf8');
  splits.preRegistration['calibrationSha'] = createHash('sha256').update(text, 'utf8').digest('hex');
  await writeFile(splitsPath, `${JSON.stringify(splits, null, 2)}\n`, 'utf8');
}
