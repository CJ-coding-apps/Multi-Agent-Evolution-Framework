import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CALIBRATION_RULE, selectCalibrated } from '@maf/eval-harness';
import type { CalibrationUsage } from '@maf/eval-harness';

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
  opts: { usage?: CalibrationUsage; adapter?: string } = {},
): Promise<void> {
  const splitsPath = path.join(corpusRoot, 'splits.json');
  const splits = JSON.parse(await readFile(splitsPath, 'utf8')) as {
    heldOut: string[];
    preRegistration: Record<string, unknown>;
  };
  const counts = splits.heldOut.map((taskId) => ({ taskId, passes: 1, attempts: 3 }));
  const record = {
    version: 1, harnessId: 'test-fixture', harnessSha: 'a'.repeat(64),
    adapter: opts.adapter ?? 'scripted', runs: 3,
    ranAt: '2026-11-13T00:00:00.000Z', splitsSha: 'test-fixture', rule: CALIBRATION_RULE,
    tasks: counts, errors: [], selection: selectCalibrated(counts),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path.join(corpusRoot, 'calibration.json'), text, 'utf8');
  splits.preRegistration['calibrationSha'] = createHash('sha256').update(text, 'utf8').digest('hex');
  await writeFile(splitsPath, `${JSON.stringify(splits, null, 2)}\n`, 'utf8');
}
