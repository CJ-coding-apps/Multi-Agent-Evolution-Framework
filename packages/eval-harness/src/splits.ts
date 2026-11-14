import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@maf/harness-config';
import { refusePrototypeKey } from '@maf/types';
import type { GoldenTask } from './GoldenTask.js';
import { HELD_OUT_RULE } from './significance.js';
import type { HeldOutTestRule } from './significance.js';
import { CALIBRATION_FILE, CALIBRATION_RULE, selectCalibrated } from './calibration.js';
import type { CalibrationRecord, CalibrationSelection } from './calibration.js';

/**
 * The corpus split (D-57). The evolver may see the `train` tasks — they are what it measures every
 * candidate on, and their results are written to the graph it digests. The `heldOut` tasks are the
 * yardstick it must not see: no candidate is selected on them, nothing about them enters the
 * evidence graph, and they are scored only after the run, on the harness that survived.
 *
 * The split is a separate committed file rather than a field on `corpus.json`, because
 * `computeCorpusSha` hashes the corpus — adding a field there would change the sha of every task
 * and invalidate the committed `baseline.json` for a change that does not alter a single fixture.
 */

export const SPLITS_FILE = 'splits.json';

/**
 * The fewest deterministically scored held-out tasks a gate may rest on (R2-M2). Below this a
 * "held-out score" is a coin toss dressed as a measurement: one flipped task moves it by 20
 * percentage points and there is no way to tell a real improvement from a lucky one. The floor is
 * a constant, not a default — a split file may raise `minHeldOut` but never lower it below this.
 */
export const MIN_HELD_OUT = 5;

export type SplitName = 'train' | 'held-out';

/**
 * R4-A4: everything about the measurement that must be fixed in writing before any run. `gate`
 * commits the test itself; this commits its unit, the rule that chose the yardstick, and the
 * measurement the yardstick was chosen from. A session that does not match all three refuses to
 * start rather than produce a p-value nobody pre-registered.
 */
export interface PreRegistration {
  /** One attempt per task per repeat, in calibration and in the gate (R4-A2). */
  attempts: 'single';
  /** The selection rule, verbatim: the string the code implements. */
  selection: string;
  /**
   * sha256 of the `calibration.json` the held-out set was chosen from, or null before the first
   * calibrated run. A committed set with no calibration file behind it has no measurement to show.
   */
  calibrationSha: string | null;
}

export interface CorpusSplits {
  version: 1;
  /**
   * Fewest deterministically scored held-out tasks this gate requires (>= MIN_HELD_OUT). Declared
   * in the committed file so that shrinking the yardstick is a visible edit to `splits.json`,
   * not a quiet change of what the corpus happens to contain (R2-M2).
   */
  minHeldOut: number;
  /**
   * R3-G3: the pre-registered held-out test — its runs, alpha and minimum task count. A split file
   * that names a rule this build does not implement is refused, so no session can silently run a
   * different test than the one the repository committed.
   */
  gate: HeldOutTestRule;
  /** R4-A4: the unit, the selection rule and the calibration the yardstick came from. */
  preRegistration: PreRegistration;
  /** Task ids the evolver may see and be scored on. */
  train: string[];
  /** Task ids it may not: scored only on the final harness, never recorded as evidence. */
  heldOut: string[];
  /**
   * WP-3.7b R3-G1: candidate held-out tasks, awaiting calibration. A pool task is on neither side
   * of the split: the evolver never sees it and the gate never scores it. `maf goldens calibrate`
   * measures the pool on the base harness and makes the qualifiers the new `heldOut` set, replacing
   * the old one (R4-A3); a task that does not qualify stays here (it has no headroom) and is never
   * evidence either.
   */
  pool?: string[];
}

/**
 * Whether a task's verdict is a deterministic measurement — every verifier is a script, a gate or
 * a diff match — rather than a model's opinion. An `llm-judge` verifier makes the whole task
 * judge-scored: a task is only as deterministic as its least deterministic verifier (R2-M2/M3).
 */
export function isJudgeScored(task: GoldenTask): boolean {
  return task.verifiers.some((v) => v.kind === 'llm-judge');
}

export function isDeterministicTask(task: GoldenTask): boolean {
  return !isJudgeScored(task);
}

export interface LoadedSplits extends CorpusSplits {
  /** sha256 over the split definition; results from different splits do not compare. */
  sha: string;
}

export class SplitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitsError';
  }
}

/** sha256 over the canonical split definition, independent of key order and whitespace. */
export function computeSplitsSha(splits: CorpusSplits): string {
  return crypto.createHash('sha256')
    .update(canonicalJson({
      version: splits.version, minHeldOut: splits.minHeldOut, gate: splits.gate,
      preRegistration: splits.preRegistration,
      train: splits.train, heldOut: splits.heldOut, pool: splits.pool ?? [],
    }), 'utf8')
    .digest('hex');
}

/**
 * Read `<corpusRoot>/splits.json` and prove it is a partition of the corpus: every id exists,
 * no id appears twice, and every task is on exactly one side. A split that leaves a task out
 * silently shrinks the yardstick; one that names a task twice makes "held-out" a lie for that
 * task, because the evolver was scored on it during the run too.
 */
export async function loadSplits(
  corpusRoot: string, corpus: readonly GoldenTask[],
): Promise<LoadedSplits> {
  const file = path.join(corpusRoot, SPLITS_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new SplitsError(
      `no ${SPLITS_FILE} at ${corpusRoot}. D-57 needs a committed train/held-out split; ` +
      'every corpus task must appear in exactly one of the three lists (train, heldOut, pool).',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, refusePrototypeKey);
  } catch (err) {
    throw new SplitsError(`${file} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  if (o === undefined || o['version'] !== 1)
    throw new SplitsError(`${file}: version must be 1`);
  const minHeldOut = o['minHeldOut'];
  if (typeof minHeldOut !== 'number' || !Number.isInteger(minHeldOut) || minHeldOut < MIN_HELD_OUT)
    throw new SplitsError(
      `${file}: minHeldOut must be an integer of at least ${MIN_HELD_OUT} ` +
      `(got ${JSON.stringify(minHeldOut)}). A held-out gate below ${MIN_HELD_OUT} deterministically ` +
      'scored tasks cannot tell an improvement from a coin toss.',
    );
  // R3-G3: the pre-registration. The committed rule must be the one this build implements, field
  // for field; a session that ran a different test would report a p-value nobody pre-registered.
  const committedGate = o['gate'];
  if (committedGate === undefined)
    throw new SplitsError(
      `${file}: no "gate". D-57 fixes the held-out test before any run, so the split must commit ` +
      'the rule (test, runs, alpha, minTasks, decision); without it an "improvement" has no ' +
      'pre-registered meaning.',
    );
  if (canonicalJson(committedGate) !== canonicalJson(HELD_OUT_RULE)) {
    const at = (v: unknown, k: string): unknown =>
      v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    const differs = (Object.keys(HELD_OUT_RULE) as (keyof HeldOutTestRule)[])
      .filter((k) => JSON.stringify(at(committedGate, k)) !== JSON.stringify(HELD_OUT_RULE[k]))
      .map((k) => `${k} is ${JSON.stringify(at(committedGate, k))}, the code implements ${JSON.stringify(HELD_OUT_RULE[k])}`);
    throw new SplitsError(
      `${file}: the committed gate rule is not the one this build implements (${differs.join('; ')}). ` +
      'The held-out test is pre-registered: changing it is a reviewed edit to this file and to the ' +
      'code together, never a run-time choice.',
    );
  }
  // R4-A4: the rest of the pre-registration. The gate fixes the test; this fixes its unit, the
  // rule that chose the yardstick, and the measurement the yardstick came from. Each is compared
  // with the code's own constant, so a split can only run the design it was written for.
  const preRegistration = o['preRegistration'];
  if (preRegistration === undefined || preRegistration === null || typeof preRegistration !== 'object')
    throw new SplitsError(
      `${file}: no "preRegistration". D-57 fixes the measurement before any run, so the split must ` +
      'commit the attempt unit (attempts), the calibration selection rule (selection) and the ' +
      `calibration file the held-out set came from (calibrationSha), not only the test.`,
    );
  const pre = preRegistration as Record<string, unknown>;
  if (pre['attempts'] !== 'single')
    throw new SplitsError(
      `${file}: preRegistration.attempts is ${JSON.stringify(pre['attempts'])}, the code implements ` +
      '"single". Calibration and the gate both count single attempts (R4-A2); a split that says ' +
      'otherwise was measured in a different unit.',
    );
  if (pre['selection'] !== CALIBRATION_RULE)
    throw new SplitsError(
      `${file}: preRegistration.selection is not the selection rule this build implements. ` +
      `The code selects by: ${JSON.stringify(CALIBRATION_RULE)}.`,
    );
  const calibrationSha = pre['calibrationSha'];
  if (calibrationSha !== null
    && (typeof calibrationSha !== 'string' || !/^[0-9a-f]{64}$/.test(calibrationSha)))
    throw new SplitsError(
      `${file}: preRegistration.calibrationSha must be null or a sha256 hex digest ` +
      `(got ${JSON.stringify(calibrationSha)}).`,
    );
  // R5-P3 (round-4 finding R4-M1): `heldOut` is derived, never hand-written. When the split names a
  // measurement, the record it hashes to must reproduce `heldOut` exactly from its own counts and
  // the committed seed and rule. A reviewed edit to `heldOut` that is not the selection the counts
  // and rule produce is refused at load, so a yardstick cannot be chosen by preference.
  let calibrationRecord: CalibrationRecord | undefined;
  if (typeof calibrationSha === 'string') {
    let calibrationText: string;
    try {
      calibrationText = await readFile(path.join(corpusRoot, CALIBRATION_FILE), 'utf8');
    } catch {
      throw new SplitsError(
        `${file}: preRegistration.calibrationSha is ${calibrationSha.slice(0, 12)}…, but there is no ` +
        `${CALIBRATION_FILE} at ${corpusRoot}. The yardstick must come with the measurement behind it.`,
      );
    }
    const actual = crypto.createHash('sha256').update(calibrationText, 'utf8').digest('hex');
    if (actual !== calibrationSha)
      throw new SplitsError(
        `${file}: preRegistration.calibrationSha is ${calibrationSha.slice(0, 12)}…, but ` +
        `${CALIBRATION_FILE} hashes to ${actual.slice(0, 12)}… — the committed held-out set does not ` +
        'come from the measurement the split names.',
      );
    let record: unknown;
    try {
      record = JSON.parse(calibrationText, refusePrototypeKey);
    } catch (err) {
      throw new SplitsError(
        `${CALIBRATION_FILE} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const recorded = record !== null && typeof record === 'object' ? record as Record<string, unknown> : undefined;
    if (recorded === undefined || recorded['version'] !== 1 || !Array.isArray(recorded['tasks']))
      throw new SplitsError(`${CALIBRATION_FILE}: version must be 1 and tasks must be an array of counts.`);
    calibrationRecord = recorded as unknown as CalibrationRecord;
  }
  const known = new Set(corpus.map((t) => t.id));
  const lists: { train: string[]; 'held-out': string[]; pool: string[] } = { train: [], 'held-out': [], pool: [] };
  // `pool` is optional (a corpus that has not run calibration has none); train and heldOut are not.
  for (const [key, value] of [['train', o['train']], ['heldOut', o['heldOut']], ['pool', o['pool']]] as const) {
    if (key === 'pool' && value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0))
      throw new SplitsError(`${file}: ${key} must be an array of task ids`);
    const ids = value as string[];
    for (const id of ids) {
      if (!known.has(id))
        throw new SplitsError(`${file}: ${key} names "${id}", which is not in the corpus at ${corpusRoot}`);
    }
    lists[key === 'heldOut' ? 'held-out' : key] = ids;
  }
  const sides: [string, string[]][] = [
    ['train', lists.train], ['held-out', lists['held-out']], ['pool', lists.pool],
  ];
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const left = sides[i]![0];
      const right = sides[j]![0];
      const both = sides[i]![1].filter((id) => sides[j]![1].includes(id));
      if (both.length > 0)
        throw new SplitsError(`${file}: ${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} on both sides of the split (${left} and ${right})`);
    }
  }
  for (const [name, ids] of sides) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) throw new SplitsError(`${file}: ${name} names ${dupes.join(', ')} more than once`);
  }
  const missing = [...known].filter(
    (id) => !lists.train.includes(id) && !lists['held-out'].includes(id) && !lists.pool.includes(id),
  );
  if (missing.length > 0)
    throw new SplitsError(`${file}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} in none of train, heldOut or pool`);
  if (lists.train.length === 0 || lists['held-out'].length === 0)
    throw new SplitsError(`${file}: both sides need at least one task (train ${lists.train.length}, held-out ${lists['held-out'].length})`);

  // R2-M2: the declared floor is enforced on the corpus, not just recorded. Judge-scored held-out
  // tasks are reported beside a gate, never counted toward it — a model's opinion is not a measure.
  const byId = new Map(corpus.map((t) => [t.id, t]));
  const deterministic = lists['held-out'].filter((id) => isDeterministicTask(byId.get(id)!));
  const judgeOnly = lists['held-out'].filter((id) => !deterministic.includes(id));
  if (deterministic.length < minHeldOut) {
    throw new SplitsError(
      `${file}: the held-out split has ${deterministic.length} deterministically scored ` +
      `task${deterministic.length === 1 ? '' : 's'} (${deterministic.join(', ') || 'none'}); ` +
      `minHeldOut is ${minHeldOut}. ` +
      (judgeOnly.length > 0
        ? `${judgeOnly.join(', ')} ${judgeOnly.length === 1 ? 'is' : 'are'} judge-scored and do not count. `
        : '') +
      'Add deterministic held-out tasks or move them from train; do not lower minHeldOut.',
    );
  }

  // R5-P3: recompute the selection the committed counts and rule produce and require it to be the
  // committed `heldOut` — same tasks, same order. `selectCalibrated` reads the seed and the rule from
  // this build, so a split can only carry a yardstick the measurement behind it derives.
  if (calibrationRecord !== undefined) {
    let derived: CalibrationSelection;
    try {
      derived = selectCalibrated(calibrationRecord.tasks);
    } catch (err) {
      throw new SplitsError(
        `${CALIBRATION_FILE}: cannot derive the held-out selection from its counts: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (canonicalJson(derived.selected) !== canonicalJson(lists['held-out']))
      throw new SplitsError(
        `${file}: heldOut is not the selection ${CALIBRATION_FILE} derives from its counts and rule ` +
        `(the record selects ${derived.selected.join(', ') || 'nothing'}; the split names ` +
        `${lists['held-out'].join(', ') || 'nothing'}). The held-out set is derived, never hand-written: ` +
        're-run `maf goldens calibrate` or restore the split the record produced.',
      );
  }

  const splits: CorpusSplits = {
    version: 1, minHeldOut, gate: HELD_OUT_RULE,
    preRegistration: { attempts: 'single', selection: CALIBRATION_RULE, calibrationSha },
    train: lists.train, heldOut: lists['held-out'], pool: lists.pool,
  };
  return { ...splits, sha: computeSplitsSha(splits) };
}
