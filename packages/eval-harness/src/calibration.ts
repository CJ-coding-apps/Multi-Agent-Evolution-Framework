import type { KeySource, SigningOptions } from '@maf/attestation';
import { signPayload, verifyPayload } from '@maf/attestation';
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

// ─── R5-P5: the probe that prices a calibration before it is paid for ────────────────────────────

/**
 * The probe's own record, beside `calibration.json` in the corpus root. It is deliberately a
 * different file: a probe measures a sample of the pool, so it cannot be the measurement a
 * committed split derives its `heldOut` from, and writing it over `calibration.json` would make a
 * partial measurement look like a whole one.
 */
export const PROBE_FILE = 'calibration-probe.json';

/** Pool tasks a probe measures when `--probe` is given without a number. */
export const PROBE_DEFAULT_TASKS = 10;

/** Seed of the probe's draw from the pool. A constant, like the selection seed: re-running a probe
 * of the same pool measures the same tasks, so two probes are comparable. */
export const PROBE_SELECTION_SEED = 0x5eed; // 24301

/**
 * R6-L1 (round-5 finding R5-L1): the probability the probe needs before a full calibration is paid
 * for. The probe used to print a point estimate and clear at a whole-task count; a sample of ten
 * cannot state a count, only how likely the pool is to reach one. `0.8` is where "5 of 10 sampled"
 * lands (exact 0.796852, printed `0.80`), which is the bar CJ set in the round-6 ruling.
 */
export const CALIBRATION_PROBE_CONFIDENCE = 0.8;

/**
 * R6-L1: the credible level of the interval the probe reports. The posterior is exact and
 * one-dimensional, so the interval is the central 80% — ten per cent in each tail.
 */
export const CALIBRATION_PROBE_INTERVAL_LEVEL = 0.8;

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
function sampleDeterministically(
  ids: readonly string[], count: number, seed: number = CALIBRATION_SELECTION_SEED,
): string[] {
  // Sorted first, so the draw depends on the SET of qualified ids and not on the order the pool
  // happens to list them in: re-ordering `splits.json` cannot change the held-out set.
  const a = [...ids].sort();
  let s = seed >>> 0;
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
function assertCalibrationCounts(counts: readonly CalibrationCount[]): void {
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
}

export function selectCalibrated(counts: readonly CalibrationCount[]): CalibrationSelection {
  assertCalibrationCounts(counts);
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
 * R5-P5: the tasks a probe measures — a seeded draw of `count` from the pool, in id order. The
 * draw is a function of the pool's SET of ids and the committed `PROBE_SELECTION_SEED`, so the same
 * pool always probes the same tasks and two probes can be compared. It says nothing about the
 * selection: the probe's counts project the whole pool (see `projectProbe`), they never pick a
 * held-out set.
 */
export function selectProbeTasks(pool: readonly string[], count: number = PROBE_DEFAULT_TASKS): string[] {
  if (!Number.isInteger(count) || count < 1)
    throw new CalibrationError(`a probe measures a positive whole number of tasks, not ${count}`);
  if (count > pool.length)
    throw new CalibrationError(
      `a probe of ${count} task${count === 1 ? '' : 's'} cannot be drawn from a pool of ${pool.length}`,
    );
  return sampleDeterministically(pool, count, PROBE_SELECTION_SEED);
}

/**
 * R5-P5: what a probe's sample implies for the whole pool. The probe is a cheap sample of the
 * calibration CJ would pay for, so the point projection is deliberately the same arithmetic as
 * `selectCalibrated`, applied to the sampled rates scaled to the pool: partial tasks (1 or 2 of 3)
 * qualify, never-solved tasks qualify only up to the cap that keeps them at most a third of the
 * kept set, and a task solved every run never qualifies.
 *
 * R6-L1: a point estimate over-states what ten tasks can say. The projection now carries the
 * posterior of the pool's qualifying count under a flat prior — the sample of `n` was drawn from
 * the pool of `N` without replacement, so conditional on a pool count `Q` the sample count is
 * hypergeometric and `P(Q | q) ∝ C(Q, q)·C(N−Q, n−q)` over `Q ∈ [q, N−n+q]`. The interval is the
 * central `CALIBRATION_PROBE_INTERVAL_LEVEL`, the probability is the exact mass at or above the
 * yardstick floor, and `clears` uses the two-decimal figure an operator reads: a probe whose
 * exact chance is 0.796852 prints 0.80 and proceeds, which is the "5 of 10" bar.
 *
 * A projection is still not a measurement. The point figure is stated as "about", and the
 * posterior assumes the ten sampled tasks are a fair draw of the pool — which is why the draw is
 * seeded and reviewed, and why the full calibration remains the authority.
 */
export interface CalibrationProbeProjection {
  /** Pool tasks measured. */
  sampled: number;
  /** Pool tasks the projection speaks for. */
  poolSize: number;
  /** Sampled counts by outcome. */
  partial: number;
  zeros: number;
  solved: number;
  /** The same three figures scaled to the pool, rounded to whole tasks. */
  projectedPartial: number;
  projectedZeros: number;
  /** The cap the rule applies to never-solved tasks at the projected size. */
  projectedZerosAllowed: number;
  /** Partial + never-solved within the cap: the raw qualifiers a full calibration would see. */
  projectedQualifying: number;
  /** R6-L1: the sample's own qualifying count, the same rule applied at sample size. */
  sampledQualifying: number;
  /** R6-L1: the posterior mean of the pool's qualifying count under the flat prior. */
  posteriorMean: number;
  /** R6-L1: the central credible interval for that count. */
  interval: { low: number; high: number; level: number };
  /** R6-L1: exact P(pool qualifying count >= the yardstick floor). */
  probabilityReachesYardstick: number;
  /**
   * R6-L1: that probability as printed (two decimals) — the figure the decision uses. The statement
   * prints the exact probability beside it, so a rounded figure never stands alone.
   */
  printedProbability: number;
  /** R6-L1: the floor the probability is about (`CALIBRATION_MIN_SELECTED`). */
  yardstick: number;
  /** R6-L1: the printed probability a probe must reach to clear. */
  confidence: number;
  clears: boolean;
  /** One sentence an operator reads before deciding to pay for a full calibration. */
  statement: string;
}

/** Exact binomial coefficient, for the hypergeometric weights (N ≤ 50 keeps every term < 2^53). */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < kk; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/**
 * R6-L1: the posterior of the pool's qualifying count given `q` qualifying in a sample of `n` from
 * a pool of `N`. Flat prior on `Q ∈ [q, N−n+q]` (a pool can never hold fewer qualifiers than the
 * sample saw, nor more than the sample plus everything it did not draw), and
 * `P(Q | q) ∝ C(Q, q)·C(N−Q, n−q)`.
 */
export function probePosterior(
  q: number, poolSize: number, sampled: number, yardstick: number,
): {
  mean: number;
  interval: { low: number; high: number; level: number };
  probabilityReachesYardstick: number;
} {
  const low = Math.max(q, 0);
  const high = poolSize - sampled + q;
  const weights: { count: number; weight: number }[] = [];
  let total = 0;
  for (let Q = low; Q <= high; Q++) {
    const weight = binomial(Q, q) * binomial(poolSize - Q, sampled - q);
    weights.push({ count: Q, weight });
    total += weight;
  }
  const mean = total === 0 ? q : weights.reduce((n, w) => n + w.count * w.weight, 0) / total;
  const tail = (1 - CALIBRATION_PROBE_INTERVAL_LEVEL) / 2;
  const quantile = (alpha: number): number => {
    let cumulative = 0;
    for (const w of weights) {
      cumulative += w.weight / total;
      if (cumulative >= alpha - 1e-12) return w.count;
    }
    return high;
  };
  const reaching = weights
    .filter((w) => w.count >= yardstick)
    .reduce((n, w) => n + w.weight, 0);
  return {
    mean,
    interval: { low: quantile(tail), high: quantile(1 - tail), level: CALIBRATION_PROBE_INTERVAL_LEVEL },
    probabilityReachesYardstick: total === 0 ? 0 : reaching / total,
  };
}

export function projectProbe(
  counts: readonly CalibrationCount[], poolSize: number,
  confidence: number = CALIBRATION_PROBE_CONFIDENCE,
  yardstick: number = CALIBRATION_MIN_SELECTED,
): CalibrationProbeProjection {
  if (counts.length === 0) throw new CalibrationError('a probe measured no tasks, so it projects nothing');
  if (!Number.isInteger(poolSize) || poolSize < counts.length)
    throw new CalibrationError(`a probe of ${counts.length} tasks cannot project a pool of ${poolSize}`);
  assertCalibrationCounts(counts);

  const sampled = counts.length;
  const partial = counts.filter((c) => c.passes > 0 && c.passes < CALIBRATION_RUNS).length;
  const zeros = counts.filter((c) => c.passes === 0).length;
  const solved = counts.filter((c) => c.passes === CALIBRATION_RUNS).length;
  const scale = (n: number): number => Math.round((n / sampled) * poolSize);
  const projectedPartial = scale(partial);
  const projectedZeros = scale(zeros);
  const projectedZerosAllowed = Math.floor(projectedPartial / 2);
  const projectedQualifying = projectedPartial + Math.min(projectedZeros, projectedZerosAllowed);
  // R6-L1: the sample's own count uses the same cap, so the posterior is asked about the same
  // quantity the pool projection describes.
  const sampledQualifying = partial + Math.min(zeros, Math.floor(partial / 2));
  const posterior = probePosterior(sampledQualifying, poolSize, sampled, yardstick);
  const printedProbability = Math.round(posterior.probabilityReachesYardstick * 100) / 100;
  const clears = printedProbability >= confidence;
  const percent = Math.round(posterior.interval.level * 100);
  const statement =
    `${sampled} of ${poolSize} pool task${poolSize === 1 ? '' : 's'} probed: ${partial} partial ` +
    `(1 or 2 of ${CALIBRATION_RUNS}), ${zeros} never solved, ${solved} solved every run — projecting ` +
    `about ${projectedQualifying} qualifying across the pool (${projectedPartial} partial + ` +
    `${Math.min(projectedZeros, projectedZerosAllowed)} never-solved within the cap). The sample holds ` +
    `${sampledQualifying} qualifier${sampledQualifying === 1 ? '' : 's'}, so the posterior puts the pool's ` +
    `count at ${posterior.interval.low}–${posterior.interval.high} (${percent}% interval, mean ` +
    `${posterior.mean.toFixed(1)}); the chance it reaches the ${yardstick}-task floor is ` +
    `${printedProbability.toFixed(2)} (exact ${posterior.probabilityReachesYardstick.toFixed(6)}), ` +
    `against the ${confidence.toFixed(2)} a full calibration needs — ` +
    (clears ? 'clears it' : 'below it');

  return {
    sampled, poolSize, partial, zeros, solved,
    projectedPartial, projectedZeros, projectedZerosAllowed, projectedQualifying,
    sampledQualifying,
    posteriorMean: posterior.mean,
    interval: posterior.interval,
    probabilityReachesYardstick: posterior.probabilityReachesYardstick,
    printedProbability,
    yardstick, confidence, clears, statement,
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
  splits: CorpusSplits, selection: CalibrationSelection, calibrationSha?: string,
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
    // R4-A4: the split names the measurement its held-out set came from, so `loadSplits` can
    // refuse a yardstick that does not hash to the committed calibration file.
    preRegistration: {
      ...splits.preRegistration,
      ...(calibrationSha !== undefined ? { calibrationSha } : {}),
    },
    train: [...splits.train, ...splits.heldOut],
    heldOut: [...selection.selected],
    pool: pool.filter((id) => !chosen.has(id)),
  };
}

/**
 * R5-P4 (round-4 finding R4-M2): what the measurement actually cost, read from the same meter that
 * charges an evolution run. `tasks` is how many tasks were measured and each was measured
 * `attemptsPerTask` times, so a later projection can compare the attempt count it is projecting
 * with the one this figure came from. With a record, a first run projects from the corpus's own
 * measurement; without one it must use the conservative constant.
 */
export interface CalibrationUsage {
  /** Model calls through the meter — every one, not one per task. */
  calls: number;
  tokens: number;
  /** Tasks measured; `tokens / tasks` is the per-task figure a projection uses. */
  tasks: number;
  /** Base runs per task in this measurement (CALIBRATION_RUNS). */
  attemptsPerTask: number;
  usd?: number;
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
  /** R5-P4: what the measurement cost, when the caller metered it. */
  usage?: CalibrationUsage;
  /** R6-L2: which key signed this record; inside the signed bytes. */
  keySource?: KeySource;
  /** R6-L2: HMAC-SHA256 over the record's canonical JSON less this field. */
  signature?: string;
}

/** A record as `runCalibration` writes it: everything but the signature, which `signCalibration` adds. */
export type UnsignedCalibrationRecord = Omit<CalibrationRecord, 'signature'>;

/**
 * R6-L2 (round-5 finding R5-L2): sign the measurement with the attestation key, by the bundle
 * rule — one HMAC over the RFC 8785 form, keyed by `MAF_SIGNING_KEY` or, when unset, the public
 * development key, which `keySource` then names.
 *
 * The split already pins this record's bytes through `preRegistration.calibrationSha`, but anyone
 * who edits the counts can recompute that sha. The signature is what they cannot recompute — a key
 * the editor does not have, which holds only when `MAF_SIGNING_KEY` is set: under the public
 * development key the "key" is in this repository, and `maf evolve`'s gate refuses such a record
 * rather than score it (R7-L3).
 */
export function signCalibration(
  record: UnsignedCalibrationRecord, signing: SigningOptions = {},
): CalibrationRecord {
  return signRecord(record, signing);
}

/**
 * R8-L3: the same two-pass signing for any record at this boundary — the calibration's and the
 * probe's. The first pass names the key, the second signs the record that carries the name, so the
 * claim about which key signed is itself signed.
 */
export function signRecord<T extends object>(
  record: T, signing: SigningOptions = {},
): T & { keySource: KeySource; signature: string } {
  const { keySource } = signPayload(record, signing);
  const complete = { ...record, keySource };
  return { ...complete, signature: signPayload(complete, signing).signature };
}

export interface CalibrationCheck {
  valid: boolean;
  /** The key that signed it, when the signature matched. */
  keySource?: KeySource;
  /** Why it is not valid, as a sentence. Absent when it is. */
  reason?: string;
}

/**
 * Whether a record read from disk carries a signature this key reproduces. A record with no
 * signature is refused outright: every `calibration.json` this build writes has one, so an
 * unsigned one was not written by a calibration run.
 */
export function verifyCalibration(
  record: unknown, signing: SigningOptions = {},
): CalibrationCheck {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    return { valid: false, reason: 'the record is not a JSON object' };
  const fields = record as Record<string, unknown>;
  const { signature, ...payload } = fields;
  if (typeof signature !== 'string')
    return {
      valid: false,
      reason: 'the record carries no signature — a calibration written by this build is signed',
    };
  if (payload['keySource'] === undefined)
    return { valid: false, reason: 'the record names no keySource, so its claim about its key is absent' };
  if (!verifyPayload(payload, signature, payload['keySource'], signing))
    return {
      valid: false,
      reason: 'the signature does not match the record\'s content under the key this check used ' +
        '(MAF_SIGNING_KEY, or the public development key when it is unset), or the record claims ' +
        'a different key from the one that signed it',
    };
  return { valid: true, keySource: payload['keySource'] as KeySource };
}

export const CALIBRATION_RULE =
  `keep tasks whose base pass count is 0, 1 or 2 of ${CALIBRATION_RUNS}; ` +
  `at most a third of the kept set may be 0 of ${CALIBRATION_RUNS}; ` +
  `at least ${CALIBRATION_MIN_SELECTED} must qualify; ` +
  `when more than ${CALIBRATION_MAX_SELECTED} qualify, ${CALIBRATION_MAX_SELECTED} are drawn by a ` +
  `fixed-seed shuffle (seed ${CALIBRATION_SELECTION_SEED}) and listed in id order`;
