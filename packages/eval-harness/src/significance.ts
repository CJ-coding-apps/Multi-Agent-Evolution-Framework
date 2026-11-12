/**
 * The held-out gate's pre-registered test (WP-3.7b R3-G3, D-57).
 *
 * Round 2 compared repeats with `min(candidate) − max(baseline) > spread`. That rule used only two
 * extreme order statistics, so a real 30%→80% gain on a couple of ten tasks was detected about 11%
 * of the time, and a lucky repeat or an unlucky one could decide the verdict. This module replaces
 * it with a fixed, one-sided exact test over per-task pass counts:
 *
 *   for every held-out task t, run each harness N times;
 *   d_t = (candidate passes) − (base passes);
 *   S   = Σ d_t;
 *   p   = the fraction of all 2^H sign assignments of the observed d_t whose sum S* is >= S;
 *   improve iff S > 0 and p < alpha.
 *
 * The sign-flip test is exact and non-parametric: under "no effect", each d_t is as likely to be
 * negative as positive, so flipping its sign gives the null distribution with no normal
 * approximation and no model of the score. It is one-sided because the question is only whether the
 * candidate got better, and it is pre-registered (runs, alpha and the minimum number of tasks live
 * in `splits.json`, and the session refuses to run when the committed rule differs from this one).
 */

/** The rule as committed in `splits.json`. Comparing it with `HELD_OUT_RULE` is the pre-registration. */
export interface HeldOutTestRule {
  /** One implementation is named; a different test is a different rule, not a flag. */
  test: 'one-sided-sign-flip-permutation';
  /** Independent runs per task, for each harness. */
  runs: number;
  /** Significance level. */
  alpha: number;
  /** Fewest held-out tasks the test may rest on. */
  minTasks: number;
  /** The decision, in words, so the file can be read without reading this source. */
  decision: string;
}

const DECISION =
  'improvement iff S > 0 and p < alpha, where d_t = candidate passes − base passes for held-out ' +
  'task t over `runs` independent runs of each harness, S = Σ_t d_t, and p is the exact one-sided ' +
  'sign-flip permutation p-value: the fraction of all 2^H sign assignments of the observed d_t ' +
  'whose sum S* is at least S, with H the number of held-out tasks.';

export const HELD_OUT_RULE: HeldOutTestRule = {
  test: 'one-sided-sign-flip-permutation',
  runs: 5,
  alpha: 0.05,
  minTasks: 10,
  decision: DECISION,
};

/** One held-out task's measurement: how many of its `runs` runs each harness passed. */
export interface HeldOutTaskPasses {
  taskId: string;
  base: number;
  candidate: number;
}

export interface HeldOutDelta {
  taskId: string;
  base: number;
  candidate: number;
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
  /** Exact one-sided p-value, P(S* >= S). */
  p: number;
  improved: boolean;
  /** Every d_t, in the order supplied — the numbers the verdict used. */
  deltas: HeldOutDelta[];
  /** Why it is not an improvement, when it is not. */
  reason?: string;
}

/**
 * The exact one-sided sign-flip p-value for observed deltas: P(S* >= S) over the 2^H assignments
 * ε_i ∈ {−1, +1} of S* = Σ ε_i d_i.
 *
 * Computed by counting, not sampling: a subset-sum table over the achievable sums holds the exact
 * number of sign assignments for each. A zero delta doubles both the numerator and the denominator,
 * so keeping zeros in the list is exactly equivalent to dropping them and costs nothing but table
 * width — which is why the count is over all H tasks, as the rule says. Counts are BigInt because
 * 2^H leaves the exact-integer range of a double around H = 53 and an approximate p is not an exact
 * test; the returned ratio is rounded to twelve decimal places, far finer than `alpha`.
 */
export function signFlipPValue(deltas: readonly number[]): number {
  const H = deltas.length;
  if (H === 0) return 1;
  const total = 2n ** BigInt(H);
  const offset = deltas.reduce((n, d) => n + Math.abs(d), 0);
  const width = 2 * offset + 1;
  let counts: bigint[] = new Array<bigint>(width).fill(0n);
  counts[offset] = 1n;
  let reach = 0;
  for (const d of deltas) {
    const next: bigint[] = new Array<bigint>(width).fill(0n);
    for (let s = -reach; s <= reach; s++) {
      const c = counts[s + offset]!;
      if (c === 0n) continue;
      next[s + d + offset] = (next[s + d + offset] ?? 0n) + c;
      next[s - d + offset] = (next[s - d + offset] ?? 0n) + c;
    }
    counts = next;
    reach += Math.abs(d);
  }
  const S = deltas.reduce((n, d) => n + d, 0);
  let atLeast = 0n;
  // Every achievable sum lies in [−offset, offset]; S does too, because |S| <= Σ|d_i| = offset.
  for (let s = Math.max(S, -offset); s <= offset; s++) atLeast += counts[s + offset] ?? 0n;
  return Number((atLeast * 1_000_000_000_000n) / total) / 1e12;
}

/**
 * The gate's verdict. The three clauses are checked in order and the first that fails is the
 * reason, so a report says what stopped it rather than only that it stopped:
 *
 *   1. at least `minTasks` tasks (H >= 10) — below that no exact test can reach the level;
 *   2. S > 0 — the candidate must gain overall;
 *   3. p < alpha — the gain must be unlikely under the sign-flip null.
 */
export function signFlipGate(
  perTask: readonly HeldOutTaskPasses[], rule: HeldOutTestRule = HELD_OUT_RULE,
): HeldOutGateVerdict {
  for (const t of perTask) {
    for (const [who, n] of [['base', t.base], ['candidate', t.candidate]] as const) {
      if (!Number.isInteger(n) || n < 0 || n > rule.runs)
        throw new Error(
          `held-out gate: ${t.taskId} has ${n} ${who} passes, but the test is fixed at ${rule.runs} runs per task.`,
        );
    }
  }
  const deltas: HeldOutDelta[] = perTask.map((t) => ({ ...t, d: t.candidate - t.base }));
  const H = deltas.length;
  const S = deltas.reduce((n, d) => n + d.d, 0);
  const p = signFlipPValue(deltas.map((d) => d.d));
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
