/**
 * The held-out gate's pre-registered test (WP-3.7b R4-A1, D-57).
 *
 * Round 2 compared repeats with `min(candidate) − max(baseline) > spread`; round 3 replaced that
 * with a one-sided sign-flip test over per-task deltas. Both were exact, and the sign-flip version
 * matched brute force — but it was under-powered: a candidate that truly lifted 30% of the held-out
 * tasks from 0.3 to 0.8 was certified about once in five sessions, because a one-run delta per task
 * throws away the within-task evidence and the reachable sums are coarse.
 *
 * This module implements CJ's round-4 choice (option A): for every held-out task t the base and the
 * candidate each run N single attempts. Let k_t be the total passes out of 2N. Under "no effect"
 * the task's 2N attempt outcomes are exchangeable, so the candidate's N labels are a uniformly
 * random N-subset and
 *
 *   candidatePasses_t ~ Hypergeometric(2N, k_t, N), independently across tasks;
 *   S = Σ_t (candidatePasses_t − basePasses_t) = 2·Σ_t candidatePasses_t − Σ_t k_t;
 *   p = P(Σ_t X_t >= Σ_t candidatePasses_t), the hypergeometric convolution.
 *
 * The convolution is computed exactly in integers (BigInt), not sampled and not approximated: the
 * denominator is C(2N, N)^H, so the p-value is a ratio of exact counts. The test is one-sided
 * because the question is only whether the candidate got better, and it is pre-registered: the
 * run count, alpha, the minimum number of tasks and the decision sentence live in `splits.json`,
 * and the session refuses to run when the committed rule differs from this one.
 */

/** The rule as committed in `splits.json`. Comparing it with `HELD_OUT_RULE` is the pre-registration. */
export interface HeldOutTestRule {
  /** One implementation is named; a different test is a different rule, not a flag. */
  test: 'one-sided-stratified-permutation';
  /** Single attempts per task, for each harness. */
  runs: number;
  /** Significance level. */
  alpha: number;
  /** Fewest held-out tasks the test may rest on. */
  minTasks: number;
  /** The decision, in words, so the file can be read without reading this source. */
  decision: string;
}

const DECISION =
  'improvement iff S > 0 and p < alpha, where for every held-out task t the base and the candidate ' +
  'each run `runs` single attempts, S = Σ_t (candidate passes_t − base passes_t), and p is the ' +
  'exact one-sided stratified permutation p-value: with k_t = base passes_t + candidate passes_t, ' +
  "the candidate's `runs` labels among the task's 2·runs attempts are exchangeable, so candidate " +
  'passes_t ~ Hypergeometric(2·runs, k_t, runs) independently across the H tasks, and p is the ' +
  'probability that the convolution of those H distributions reaches at least the observed S. ' +
  'The test needs at least `minTasks` held-out tasks.';

export const HELD_OUT_RULE: HeldOutTestRule = {
  test: 'one-sided-stratified-permutation',
  runs: 10,
  alpha: 0.05,
  minTasks: 20,
  decision: DECISION,
};

/** One held-out task's measurement: how many of its `runs` single attempts each harness passed. */
export interface HeldOutTaskPasses {
  taskId: string;
  base: number;
  candidate: number;
}

export interface HeldOutDelta {
  taskId: string;
  base: number;
  candidate: number;
  /** base + candidate: how many of the task's 2·runs attempts passed under either label. */
  k: number;
  /** candidate − base. */
  d: number;
}

export interface HeldOutGateVerdict {
  runs: number;
  alpha: number;
  /** Number of tasks the test was computed over. */
  H: number;
  /** Σ d_t. */
  S: number;
  /** Exact one-sided stratified permutation p-value. */
  p: number;
  improved: boolean;
  /** Every task's counts, in the order supplied — the numbers the verdict used. */
  deltas: HeldOutDelta[];
  /** Why it is not an improvement, when it is not. */
  reason?: string;
}

/** C(n, r) as an exact integer; 0 outside 0 <= r <= n. */
function choose(n: number, r: number): bigint {
  if (r < 0 || r > n) return 0n;
  let out = 1n;
  for (let i = 0n; i < BigInt(r); i++) out = (out * (BigInt(n) - i)) / (i + 1n);
  return out;
}

/**
 * The exact one-sided stratified permutation p-value.
 *
 * For each task, the number of label assignments giving the candidate x passes out of N at total
 * k = base + candidate is C(k, x) · C(2N − k, N − x); there are C(2N, N) assignments in all. The
 * per-task distributions are convolved over the sum of candidate passes, and the p-value is the
 * exact count of assignments at or above the observed sum, over C(2N, N)^H.
 *
 * Counting, not sampling: the numerator and denominator are exact integers (BigInt), because
 * C(20, 10)^20 is far outside the exact-integer range of a double and an approximate p is not an
 * exact test. Only the final ratio is turned into a double, so a tail p is reported as the small
 * number it is rather than collapsing to zero.
 */
export function stratifiedPValue(
  perTask: readonly HeldOutTaskPasses[], runs: number,
): number {
  const H = perTask.length;
  if (H === 0) return 1;
  const N = runs;
  const twoN = 2 * N;
  const perTaskWays = choose(twoN, N);
  if (perTaskWays === 0n) return 1;

  // Convolve the per-task candidate-pass distributions: ways[s] = number of label assignments over
  // all tasks processed so far with total candidate passes s.
  let ways: bigint[] = [1n];
  let observed = 0;
  for (const t of perTask) {
    const k = t.base + t.candidate;
    const dist: bigint[] = new Array<bigint>(N + 1).fill(0n);
    for (let x = Math.max(0, N - (twoN - k)); x <= Math.min(N, k); x++) {
      dist[x] = choose(k, x) * choose(twoN - k, N - x);
    }
    observed += t.candidate;
    const next: bigint[] = new Array<bigint>(ways.length + N).fill(0n);
    for (let s = 0; s < ways.length; s++) {
      const c = ways[s]!;
      if (c === 0n) continue;
      for (let x = 0; x <= N; x++) {
        const d = dist[x]!;
        if (d !== 0n) next[s + x] = (next[s + x] ?? 0n) + c * d;
      }
    }
    ways = next;
  }

  let atLeast = 0n;
  for (let s = observed; s < ways.length; s++) atLeast += ways[s] ?? 0n;
  const denominator = perTaskWays ** BigInt(H);
  // Both sides are exact integers whose ratio is the exact p-value; the double conversion is the
  // one rounding in the whole computation, and it keeps a 1e-23 tail from rounding to zero.
  return Number(atLeast) / Number(denominator);
}

/**
 * The gate's verdict. The clauses are checked in order and the first that fails is the reason, so
 * a report says what stopped it rather than only that it stopped:
 *
 *   1. at least `minTasks` tasks (H >= 20) — the pre-registered design;
 *   2. S > 0 — the candidate must gain overall;
 *   3. p < alpha — the gain must be unlikely under the stratified permutation null.
 */
export function stratifiedGate(
  perTask: readonly HeldOutTaskPasses[], rule: HeldOutTestRule = HELD_OUT_RULE,
): HeldOutGateVerdict {
  for (const t of perTask) {
    for (const [who, n] of [['base', t.base], ['candidate', t.candidate]] as const) {
      if (!Number.isInteger(n) || n < 0 || n > rule.runs)
        throw new Error(
          `held-out gate: ${t.taskId} has ${n} ${who} passes, but the test is fixed at ${rule.runs} single attempts per task.`,
        );
    }
  }
  const deltas: HeldOutDelta[] = perTask.map((t) => ({
    ...t, k: t.base + t.candidate, d: t.candidate - t.base,
  }));
  const H = deltas.length;
  const S = deltas.reduce((n, d) => n + d.d, 0);
  const p = stratifiedPValue(perTask, rule.runs);
  const verdict = { runs: rule.runs, alpha: rule.alpha, H, S, p, deltas };
  if (H < rule.minTasks) {
    return {
      ...verdict, improved: false,
      reason: `the pre-registered test needs at least ${rule.minTasks} held-out tasks; the split has ${H}`,
    };
  }
  if (S <= 0) {
    return {
      ...verdict, improved: false,
      reason: `S = ${S}: the candidate did not gain overall (the test needs S > 0)`,
    };
  }
  if (!(p < rule.alpha)) {
    return {
      ...verdict, improved: false,
      reason: `p = ${p} is not below alpha = ${rule.alpha}`,
    };
  }
  return { ...verdict, improved: true };
}
