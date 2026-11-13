import type { CorpusSplits } from './splits.js';

/**
 * Held-out calibration (WP-3.7b R3-G2, D-57). A held-out task is only worth a gate if the base
 * harness sometimes passes it and sometimes fails it: a task the base always solves has no headroom
 * to measure an improvement against, and a task it never solves may be unsolvable, broken, or
 * simply beyond the base for a reason no candidate can address.
 *
 * `maf goldens calibrate` runs the BASE harness on each pool task a fixed number of times, writes
 * the per-task pass counts to `calibration.json`, and makes the qualifiers the new `heldOut` set in
 * `splits.json` — replacing whatever was there (R4-A3). Both files are committed together, so the
 * yardstick is a visible, reviewed edit and its sha changes with it. The calibration counts are
 * NOT the gate's baseline:
 * the gate re-measures the base itself, because a calibration run and a gate run differ in their
 * isolation and the day they ran.
 *
 * R4-A2: the unit is the single attempt, in both places. A calibration count is "how many of
 * `CALIBRATION_RUNS` single attempts passed"; a gate count is "how many of the ten single attempts
 * passed". Neither stage gives a task two tries that count as one.
 */

/** The committed record of a calibration run, beside `splits.json` in the corpus root. */
export const CALIBRATION_FILE = 'calibration.json';

/** Independent base runs per pool task. The selection rule below is stated for exactly this many. */
export const CALIBRATION_RUNS = 3;

/**
 * Fewest tasks a calibrated held-out set may contain. Below this the gate has no power — and at
 * this size it is the number the power claim in `power.test.ts` is stated for (R4-A5).
 */
export const CALIBRATION_MIN_SELECTED = 20;

/**
 * Most tasks the calibrated held-out set may contain. The gate's power and its cost are both
 * stated for exactly this many tasks, so a larger pool does not buy a larger yardstick: it is
 * sampled down deterministically (see `CALIBRATION_SELECTION_SEED`). R4-A3.
 */
export const CALIBRATION_MAX_SELECTED = 20;

/**
 * Seed of the deterministic choice made when more than `CALIBRATION_MAX_SELECTED` tasks qualify.
 * It is a constant, not an argument: there is no command-line flag, no clock and no `Math.random`
 * on this path, so the same counts always yield the same held-out set. The seed is recorded with
 * the selection in `calibration.json` and written into `splits.json`'s pre-registration (R4-A4),
 * so a reviewed split can be re-derived from its measurement.
 */
export const CALIBRATION_SELECTION_SEED = 0x37b20; // 228128

export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationError';
  }
}

/** One pool task's measurement: how many of its independent base runs passed. */
export interface CalibrationCount {
  taskId: string;
  /** Passing runs, 0..attempts. */
  passes: number;
  /** Independent runs attempted for this task; exactly CALIBRATION_RUNS. */
  attempts: number;
}

export interface CalibrationSelection {
  /**
   * Tasks that become held-out. In pool order when every qualified task fits; otherwise the
   * deterministic sample, in id order (R4-A3).
   */
  selected: string[];
  /** Tasks the base solved in every run: no headroom, never selected. */
  droppedAlwaysSolved: string[];
  /**
   * Tasks the base never solved, beyond what the one-third cap allows. Kept in the pool: they may
   * still be worth a later look, but a held-out set that is mostly never-passed tasks measures
   * whether a candidate can do the impossible, not whether it improved.
   */
  droppedAlwaysFailed: string[];
  /** How many never-solved tasks the rule allowed, and how many are in the kept set. */
  zerosAllowed: number;
  zerosKept: number;
  /** Every task that passed the 0-2/3 rule, before the deterministic choice, in pool order. */
  qualifiedIds: string[];
  /** Qualified but not drawn, because the pool is larger than the yardstick: reported, not silent. */
  notDrawn: string[];
  /** Whether more qualified than `CALIBRATION_MAX_SELECTED`, so the choice below had to run. */
  sampled: boolean;
  /** The seed of that choice, present only when it ran. */
  seed?: number;
  qualified: boolean;
  /** Why the run does not qualify, when it does not. */
  reason?: string;
}

/**
 * The deterministic choice made when more than `CALIBRATION_MAX_SELECTED` tasks qualify: a seeded
 * Fisher-Yates over the qualified ids, the first `count` kept, then sorted by id. A plain LCG
 * (mulberry32) is enough here — nothing about this choice is security-relevant, and writing it out
 * keeps the decision reproducible from the seed alone, in this build and any later one that copies
 * these four lines.
 */
function sampleDeterministically(ids: readonly string[], count: number): string[] {
  // Sorted first, so the draw depends on the SET of qualified ids and not on the order the pool
  // happens to list them in: re-ordering `splits.json` cannot change the held-out set.
  const a = [...ids].sort();
  let s = CALIBRATION_SELECTION_SEED >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, count).sort();
}

/**
 * The pre-registered selection rule, verbatim (CJ's round-3 decision, extended in round 4):
 *
 *   keep tasks whose base pass count is 0, 1 or 2 of 3;
 *   at most a third of the kept set may be 0 of 3;
 *   at least 20 must qualify;
 *   when more than 20 qualify, 20 are drawn by a fixed-seed shuffle and listed in id order.
 *
 * "At most a third of the kept set" is arithmetic, not a judgement call: a kept set of `p` partial
 * tasks plus `z` never-solved tasks satisfies `z <= (p + z) / 3` exactly when `z <= floor(p / 2)`,
 * which is the cap implemented here. When the cap binds, the never-solved tasks are kept in the
 * order the caller supplies them (the pool order in `splits.json`), so which ones survive is
 * reproducible and auditable, not a choice made at run time. R4-A3 applies the same standard to
 * the over-full case: the seed is a constant and the result is sorted, so the held-out set is a
 * function of the counts alone.
 */
export function selectCalibrated(counts: readonly CalibrationCount[]): CalibrationSelection {
  const seen = new Set<string>();
  for (const c of counts) {
    if (seen.has(c.taskId)) throw new CalibrationError(`calibration counts list ${c.taskId} more than once`);
    seen.add(c.taskId);
    if (c.attempts !== CALIBRATION_RUNS)
      throw new CalibrationError(
        `calibration for ${c.taskId} ran ${c.attempts} time(s); the selection rule is pre-registered for ` +
        `${CALIBRATION_RUNS} and is not read from the command line.`,
      );
    if (!Number.isInteger(c.passes) || c.passes < 0 || c.passes > c.attempts)
      throw new CalibrationError(`calibration for ${c.taskId} has ${c.passes} passes of ${c.attempts}`);
  }
  const partial = counts.filter((c) => c.passes > 0 && c.passes < CALIBRATION_RUNS);
  const zeros = counts.filter((c) => c.passes === 0);
  const zerosAllowed = Math.floor(partial.length / 2);
  const keptZeros = new Set(zeros.slice(0, zerosAllowed).map((c) => c.taskId));
  const qualifiedIds = counts
    .filter((c) => (c.passes > 0 && c.passes < CALIBRATION_RUNS) || keptZeros.has(c.taskId))
    .map((c) => c.taskId);
  // R4-A3: the yardstick is exactly CALIBRATION_MAX_SELECTED tasks when the pool can supply them.
  // The sample is drawn within the two strata, zeros first, so the "at most a third never-solved"
  // cap still holds of the set that is actually kept: a set of 20 may contain at most six 0/3
  // tasks, the same inequality `zerosAllowed` enforces one stage earlier.
  const sampled = qualifiedIds.length > CALIBRATION_MAX_SELECTED;
  const maxZerosInSample = Math.floor(CALIBRATION_MAX_SELECTED / 3);
  const keptZeroIds = qualifiedIds.filter((id) => keptZeros.has(id));
  const partialIds = qualifiedIds.filter((id) => !keptZeros.has(id));
  const zerosTaken = sampled
    ? sampleDeterministically(keptZeroIds, Math.min(keptZeroIds.length, maxZerosInSample))
    : keptZeroIds;
  const partialsTaken = sampled
    ? sampleDeterministically(partialIds, CALIBRATION_MAX_SELECTED - zerosTaken.length)
    : partialIds;
  const selected = sampled ? [...partialsTaken, ...zerosTaken].sort() : qualifiedIds;
  const qualified = selected.length >= CALIBRATION_MIN_SELECTED;
  const drawn = new Set(selected);
  return {
    selected,
    droppedAlwaysSolved: counts.filter((c) => c.passes === CALIBRATION_RUNS).map((c) => c.taskId),
    droppedAlwaysFailed: zeros.filter((c) => !keptZeros.has(c.taskId)).map((c) => c.taskId),
    /** Qualified but not drawn: the pool is larger than the yardstick (R4-A3). */
    notDrawn: qualifiedIds.filter((id) => !drawn.has(id)),
    zerosAllowed,
    zerosKept: zerosTaken.length,
    qualifiedIds,
    sampled,
    ...(sampled ? { seed: CALIBRATION_SELECTION_SEED } : {}),
    qualified,
    ...(qualified ? {} : {
      reason: `only ${selected.length} task${selected.length === 1 ? '' : 's'} qualified; ` +
        `the rule needs at least ${CALIBRATION_MIN_SELECTED}.`,
    }),
  };
}

/**
 * Replaces `heldOut` with the calibrated selection (R4-A3; round-3 finding L1). The previous
 * held-out set is retired to `train`: it is no longer the yardstick — the tasks CJ described as
 * "old easy and model-judged" are not kept alongside the new ones — and it must stay somewhere, or
 * the split stops being a partition of the corpus. Retiring them to `train` keeps them out of the
 * gate forever while leaving the corpus intact.
 */
export function applyCalibration(
  splits: CorpusSplits, selection: CalibrationSelection,
): CorpusSplits {
  const pool = splits.pool ?? [];
  const notPooled = selection.selected.filter((id) => !pool.includes(id));
  if (notPooled.length > 0)
    throw new CalibrationError(
      `calibration selected ${notPooled.join(', ')}, which ${notPooled.length === 1 ? 'is' : 'are'} not in the pool; ` +
      'only pool tasks may be calibrated into the held-out set.',
    );
  if (new Set(selection.selected).size !== selection.selected.length)
    throw new CalibrationError('calibration selected a task more than once');
  const chosen = new Set(selection.selected);
  return {
    version: splits.version,
    minHeldOut: splits.minHeldOut,
    gate: splits.gate,
    train: [...splits.train, ...splits.heldOut],
    heldOut: [...selection.selected],
    pool: pool.filter((id) => !chosen.has(id)),
  };
}

/**
 * The committed record of one calibration run. `harnessSha` and `ranAt` make it possible to say
 * which base harness produced these counts, months later; `rule` repeats the selection rule so the
 * file can be audited without reading this source; `selection` records the decision, including what
 * was dropped and why, so the edit to `splits.json` can be reviewed as a consequence of a
 * measurement rather than as a preference.
 */
export interface CalibrationRecord {
  version: 1;
  harnessId: string;
  harnessSha: string;
  adapter: string;
  model?: string;
  /** Independent base runs per task. */
  runs: number;
  /** ISO timestamp of the run. */
  ranAt: string;
  /** sha256 of the corpus these tasks were drawn from. */
  corpusSha?: string;
  /** `sha` of the `splits.json` this run was decided against. */
  splitsSha: string;
  rule: string;
  tasks: CalibrationCount[];
  /** Attempts that ended in an error, by task: a crash is not a measurement. */
  errors: { taskId: string; attempt: number; error: string }[];
  selection: CalibrationSelection;
}

export const CALIBRATION_RULE =
  `keep tasks whose base pass count is 0, 1 or 2 of ${CALIBRATION_RUNS}; ` +
  `at most a third of the kept set may be 0 of ${CALIBRATION_RUNS}; ` +
  `at least ${CALIBRATION_MIN_SELECTED} must qualify; ` +
  `when more than ${CALIBRATION_MAX_SELECTED} qualify, ${CALIBRATION_MAX_SELECTED} are drawn by a ` +
  `fixed-seed shuffle (seed ${CALIBRATION_SELECTION_SEED}) and listed in id order`;
