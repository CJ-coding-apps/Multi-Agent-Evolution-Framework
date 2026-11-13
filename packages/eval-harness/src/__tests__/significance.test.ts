import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_OUT_RULE, stratifiedGate, stratifiedPValue } from '../index.js';
import type { HeldOutTaskPasses } from '../index.js';

// ORACLE: D-57 / R4-A1 — the held-out verdict is an exact one-sided stratified within-task
// permutation test, pre-registered in code and in `splits.json`. Its unit is the single attempt:
// for each task the base and the candidate each ran N attempts, and the test asks how surprising
// the candidate's share of the task's k_t passes is.

/**
 * Brute force: every way the candidate's N of the task's 2N attempt slots could have been chosen,
 * with the first k slots the passes. Independent of the hypergeometric formula the code uses — it
 * enumerates the label assignments the null hypothesis is about.
 */
function candidateCounts(k: number, runs: number): number[] {
  const twoN = 2 * runs;
  const out: number[] = [];
  const walk = (pos: number, left: number, passes: number): void => {
    if (left === 0) {
      out.push(passes);
      return;
    }
    if (twoN - pos < left) return;
    walk(pos + 1, left - 1, passes + (pos < k ? 1 : 0));
    walk(pos + 1, left, passes);
  };
  walk(0, runs, 0);
  return out;
}

function bruteForceP(perTask: readonly HeldOutTaskPasses[], runs: number): number {
  let dist = new Map<number, number>([[0, 1]]);
  let total = 1;
  for (const t of perTask) {
    const counts = candidateCounts(t.base + t.candidate, runs);
    const next = new Map<number, number>();
    for (const [s, w] of dist) for (const x of counts) next.set(s + x, (next.get(s + x) ?? 0) + w);
    dist = next;
    total *= counts.length;
  }
  const observed = perTask.reduce((n, t) => n + t.candidate, 0);
  let atLeast = 0;
  for (const [s, w] of dist) if (s >= observed) atLeast += w;
  return atLeast / total;
}

const passes = (taskId: string, base: number, candidate: number): HeldOutTaskPasses =>
  ({ taskId, base, candidate });

/** Twenty tasks: `gainers` of them at base→candidate, the rest neutral at 5/5. */
function twenty(gainers: number, base: number, candidate: number): HeldOutTaskPasses[] {
  return Array.from({ length: 20 }, (_, i) => (i < gainers
    ? passes(`t${i}`, base, candidate)
    : passes(`t${i}`, 5, 5)));
}

test('significance: the exact p-value matches brute-force label enumeration on small cases', () => {
  // Known cases first: one task, two attempts, both passes on the candidate's side.
  // The candidate's 2 slots are drawn from 2 passes and 2 fails, so P(both passes) = 1/6.
  assert.equal(stratifiedPValue([passes('a', 0, 2)], 2), 1 / 6);
  // Three passes among four slots: P(the observed two are both passes) = C(3,2)/C(4,2) = 1/2.
  assert.equal(stratifiedPValue([passes('a', 1, 2)], 2), 1 / 2);
  // Independent tasks multiply: (1/6)^2.
  assert.equal(stratifiedPValue([passes('a', 0, 2), passes('b', 0, 2)], 2), 1 / 36);
  // Three attempts: C(6,3) = 20 assignments, one of which gives the candidate all three passes.
  assert.equal(stratifiedPValue([passes('a', 0, 3), passes('b', 0, 3)], 3), 1 / 400);

  // Every small shape up to 3 attempts and 3 tasks, against the enumeration.
  for (const runs of [1, 2, 3]) {
    for (let h = 1; h <= 3; h++) {
      const cases: HeldOutTaskPasses[][] = [];
      // Deterministic sweep: task i takes (base, candidate) from a fixed list, truncated to h.
      const shapes = [
        [0, runs], [runs, runs], [1, Math.min(runs, 2)], [0, 0],
        [Math.floor(runs / 2), Math.min(runs, Math.floor(runs / 2) + 1)],
        [runs, 0],
      ] as const;
      for (let a = 0; a < shapes.length; a++) {
        for (let b = 0; b < shapes.length; b++) {
          cases.push(Array.from({ length: h }, (_, i) => {
            const [base, candidate] = shapes[(a + b + i) % shapes.length]!;
            return passes(`t${i}`, base, candidate);
          }));
        }
      }
      for (const perTask of cases) {
        assert.equal(
          stratifiedPValue(perTask, runs), bruteForceP(perTask, runs),
          JSON.stringify({ runs, perTask }),
        );
      }
    }
  }
});

test('significance: the reported p-value is the exact count ratio, not an approximation', () => {
  // Twenty tasks, one of them 0/10 → 10/10 and nineteen neutral at 5/5. The exact rational is
  // 0.1899126525200621…; a normal approximation of the convolution lands visibly elsewhere, and
  // pinning the exact figure is what keeps the tail exact.
  const single = stratifiedGate(twenty(1, 0, 10));
  assert.equal(single.H, 20);
  assert.equal(single.S, 10);
  assert.equal(single.p, 0.18991265252006212);
  assert.equal(single.improved, false);

  // A broad +5 on every task: 1.79121964747758e-23, far below alpha and not rounded to zero.
  const broad = stratifiedGate(twenty(20, 3, 8));
  assert.ok(Math.abs(broad.p - 1.7912196474775826e-23) < 1e-35, `p = ${broad.p}`);
  assert.equal(broad.improved, true);
});

test('significance: a single strong task alone is reported as computed, with no special case', () => {
  // One task at 0/10 → 10/10 contributes 1/C(20,10) on its own, but the other nineteen tasks are
  // still exchangeable, so the exact stratified p is 0.19, not 5e-6: no task is privileged and
  // nothing is special-cased. The verdict is not an improvement.
  const verdict = stratifiedGate(twenty(1, 0, 10));
  assert.equal(verdict.improved, false);
  assert.match(verdict.reason ?? '', /p = 0\.18991265252006212 is not below alpha = 0\.05/);
  assert.deepEqual(verdict.deltas[0], { taskId: 't0', base: 0, candidate: 10, k: 10, d: 10 });
  assert.deepEqual(verdict.deltas[19], { taskId: 't19', base: 5, candidate: 5, k: 10, d: 0 });
});

test('significance: all tasks equal gives no improvement', () => {
  const flat = stratifiedGate(twenty(0, 5, 5));
  assert.equal(flat.S, 0);
  assert.equal(flat.improved, false);
  assert.match(flat.reason ?? '', /S = 0: the candidate did not gain overall/);
  // Equal counts that are not all-pass: still S = 0, still the S clause that decides.
  const equal = stratifiedGate(Array.from({ length: 20 }, (_, i) => passes(`t${i}`, i % 11, i % 11)));
  assert.equal(equal.S, 0);
  assert.equal(equal.improved, false);
  assert.match(equal.reason ?? '', /did not gain overall/);
});

test('significance: a gain the test just clears is an improvement, and one it does not is not', () => {
  // Nineteen tasks up by one pass and one neutral: S = 19, exact p = 0.0330… < 0.05 → improvement.
  // A two-sided reading of the same tail would be 0.066 ≥ 0.05, so pinning this verdict is what
  // keeps the test one-sided.
  const just = stratifiedGate([
    ...Array.from({ length: 19 }, (_, i) => passes(`t${i}`, 3, 4)),
    passes('t19', 5, 5),
  ]);
  assert.equal(just.S, 19);
  assert.equal(just.p, 0.0330323292167697055);
  assert.equal(just.improved, true);

  // One pass fewer of evidence, with the same shape: p = 0.1899… → not an improvement.
  assert.equal(stratifiedGate(twenty(1, 0, 10)).improved, false);
});

test('significance: fewer than twenty tasks cannot clear the pre-registered level', () => {
  // A big gain on nineteen tasks is still refused: the design is 20 held-out tasks.
  const nineteen = stratifiedGate(Array.from({ length: 19 }, (_, i) => passes(`t${i}`, 0, 10)));
  assert.equal(nineteen.H, 19);
  assert.equal(nineteen.improved, false);
  assert.match(nineteen.reason ?? '', /needs at least 20 held-out tasks; the split has 19/);
  // The twentieth task is what the rule is written for.
  const twentyPass = stratifiedGate(Array.from({ length: 20 }, (_, i) => passes(`t${i}`, 0, 10)));
  assert.equal(twentyPass.improved, true);
});

test('significance: for S <= 0 the exact one-sided p-value is never below one half', () => {
  // Each task's distribution is symmetric about k_t/2, so the sum is symmetric about Σk_t/2, and
  // S <= 0 puts the observed sum at or below that centre. Checked on explicit shapes, not assumed.
  const cases: HeldOutTaskPasses[][] = [
    Array.from({ length: 20 }, (_, i) => passes(`t${i}`, 5, 5)),
    Array.from({ length: 20 }, (_, i) => passes(`t${i}`, 10, 0)),
    twenty(1, 5, 5).map((t, i) => (i === 0 ? passes('t0', 9, 1) : t)),
    twenty(3, 1, 1).map((t, i) => (i < 3 ? passes(`t${i}`, 2, 0) : t)),
  ];
  for (const perTask of cases) {
    const verdict = stratifiedGate(perTask);
    assert.ok(verdict.S <= 0, JSON.stringify({ S: verdict.S }));
    assert.ok(verdict.p >= 0.5, JSON.stringify({ S: verdict.S, p: verdict.p }));
    assert.equal(verdict.improved, false);
  }
});

test('significance: a count outside the registered attempt count is refused', () => {
  assert.throws(() => stratifiedGate([passes('x', 0, 11)]), /has 11 candidate passes/);
  assert.throws(() => stratifiedGate([passes('x', -1, 0)]), /has -1 base passes/);
  assert.throws(() => stratifiedGate([passes('x', 0.5, 0)]), /has 0\.5 base passes/);
});

test('significance: the p-value depends on the task totals, not on the order they arrive in', () => {
  const ordered = twenty(6, 1, 3);
  const reversed = [...ordered].reverse().map((t, i) => ({ ...t, taskId: `t${i}` }));
  assert.equal(stratifiedPValue(reversed, 10), stratifiedPValue(ordered, 10));
});

test('significance: the rule is the one CJ pre-registered', () => {
  assert.equal(HELD_OUT_RULE.test, 'one-sided-stratified-permutation');
  assert.equal(HELD_OUT_RULE.runs, 10);
  assert.equal(HELD_OUT_RULE.alpha, 0.05);
  assert.equal(HELD_OUT_RULE.minTasks, 20);
  assert.match(HELD_OUT_RULE.decision, /S > 0 and p < alpha/);
  assert.match(HELD_OUT_RULE.decision, /exact one-sided stratified permutation p-value/);
  assert.match(HELD_OUT_RULE.decision, /Hypergeometric\(2·runs, k_t, runs\)/);
});
