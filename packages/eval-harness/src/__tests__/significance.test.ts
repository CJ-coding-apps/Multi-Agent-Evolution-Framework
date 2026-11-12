import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_OUT_RULE, signFlipGate, signFlipPValue } from '../index.js';
import type { HeldOutTaskPasses } from '../index.js';

// ORACLE: D-57 / R3-G3 — the held-out verdict is an exact one-sided sign-flip test, pre-registered
// in code and in `splits.json`, not a comparison of two extreme repeats.

/** A task vector with `ones` tasks gaining one pass and the rest flat, over `h` tasks at 5 runs. */
function vector(ones: number, h: number): HeldOutTaskPasses[] {
  return Array.from({ length: h }, (_, i) => (i < ones
    ? { taskId: `t${i}`, base: 1, candidate: 2 }
    : { taskId: `t${i}`, base: 1, candidate: 1 }));
}

/** The exact p-value by brute force over all 2^H sign assignments — the unit tests' own oracle. */
function bruteForceP(deltas: readonly number[]): number {
  const H = deltas.length;
  let atLeast = 0;
  for (let mask = 0; mask < 2 ** H; mask++) {
    let sum = 0;
    for (let i = 0; i < H; i++) sum += (mask >> i) & 1 ? deltas[i]! : -deltas[i]!;
    if (sum >= deltas.reduce((n, d) => n + d, 0)) atLeast++;
  }
  return atLeast / 2 ** H;
}

test('significance: the exact p-value is brute force over every sign assignment', () => {
  // Known vectors first: five +1 among five 0s is P(S* >= 5) = 2^-5.
  assert.equal(signFlipPValue([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]), 0.03125);
  // Every task +1: only the all-positive assignment reaches the full sum.
  assert.equal(signFlipPValue(new Array<number>(10).fill(1)), 1 / 1024);
  // No gain at all: every assignment reaches 0.
  assert.equal(signFlipPValue(new Array<number>(10).fill(0)), 1);
  // Mixed signs and magnitudes, checked against an independent enumeration.
  for (const deltas of [
    [2, 1, 1, 0, 0, -1, 0, 0, 0, 0],
    [3, -1, 2, 0, 1, -2, 0, 0, 0, 0],
    [1, 1, -1, 1, -1, 1, 0, 0, 0, 0],
    [5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ]) assert.equal(signFlipPValue(deltas), bruteForceP(deltas), JSON.stringify(deltas));
  // Zeros double numerator and denominator, so they cannot change the ratio.
  assert.equal(signFlipPValue([1, 1, 1]), signFlipPValue([1, 1, 1, 0, 0, 0, 0]));
});

test('significance: no gain, or one large gain alone, is not an improvement', () => {
  const flat = signFlipGate(vector(0, 10));
  assert.equal(flat.S, 0);
  assert.equal(flat.p, 1);
  assert.equal(flat.improved, false);
  assert.match(flat.reason ?? '', /S = 0: the candidate did not gain overall/);

  // One task that jumps 0/5 → 5/5 on ten tasks: p = 1/2, so a single lucky task cannot carry.
  const single = signFlipGate([
    { taskId: 'big', base: 0, candidate: 5 },
    ...Array.from({ length: 9 }, (_, i) => ({ taskId: `t${i}`, base: 2, candidate: 2 })),
  ]);
  assert.equal(single.S, 5);
  assert.equal(single.p, 0.5);
  assert.equal(single.improved, false);
  assert.match(single.reason ?? '', /p = 0\.5 is not below alpha = 0\.05/);
});

test('significance: a broad gain over ten tasks improves, and the verdict carries every d_t', () => {
  const broad = signFlipGate([
    ...Array.from({ length: 8 }, (_, i) => ({ taskId: `t${i}`, base: 0, candidate: 3 })),
    { taskId: 't8', base: 1, candidate: 1 },
    { taskId: 't9', base: 2, candidate: 2 },
  ]);
  assert.equal(broad.H, 10);
  assert.equal(broad.S, 24);
  assert.equal(broad.p, 1 / 256);
  assert.equal(broad.improved, true);
  assert.equal(broad.deltas.length, 10);
  assert.deepEqual(broad.deltas[0], { taskId: 't0', base: 0, candidate: 3, d: 3 });
});

test('significance: fewer than ten tasks cannot clear the pre-registered level, whatever the gain', () => {
  const nine = signFlipGate(vector(9, 9));
  assert.equal(nine.improved, false);
  assert.match(nine.reason ?? '', /needs at least 10 held-out tasks; the split has 9/);
  // Ten improved tasks at the same magnitude is the smallest shape that can pass.
  assert.equal(signFlipGate(vector(10, 10)).improved, true);
});

test('significance: for S <= 0 the exact one-sided p-value is never below one half', () => {
  // The theorem behind the S > 0 clause: the observed sum is itself one of the sign assignments,
  // so at least the observed assignment's mirror half reaches it. Checked, not assumed.
  const deltas = [2, 1, 0, -1, -2, 1, 1, 0, -1, -1];
  const S = deltas.reduce((n, d) => n + d, 0);
  assert.ok(S <= 0);
  for (const cut of [
    deltas,
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
    [1, -5, 1, 0, 0, 0, 0, 0, 0, 0],
  ]) {
    assert.ok(signFlipPValue(cut) >= 0.5, JSON.stringify(cut));
  }
  // Consequently a non-positive S can never satisfy p < alpha at the registered level.
  const asPasses = deltas.map((d, i) => ({
    taskId: `t${i}`, base: d < 0 ? -d : 0, candidate: d < 0 ? 0 : d,
  }));
  const verdict = signFlipGate(asPasses);
  assert.ok(verdict.S <= 0);
  assert.ok(verdict.p >= 0.5);
  assert.equal(verdict.improved, false);
});

test('significance: a count outside the registered run count is refused', () => {
  assert.throws(() => signFlipGate([{ taskId: 'x', base: 0, candidate: 6 }]), /has 6 candidate passes/);
  assert.throws(() => signFlipGate([{ taskId: 'x', base: -1, candidate: 0 }]), /has -1 base passes/);
  assert.throws(() => signFlipGate([{ taskId: 'x', base: 0.5, candidate: 0 }]), /has 0.5 base passes/);
});

test('significance: the rule is the one CJ pre-registered', () => {
  assert.equal(HELD_OUT_RULE.test, 'one-sided-sign-flip-permutation');
  assert.equal(HELD_OUT_RULE.runs, 5);
  assert.equal(HELD_OUT_RULE.alpha, 0.05);
  assert.equal(HELD_OUT_RULE.minTasks, 10);
  assert.match(HELD_OUT_RULE.decision, /S > 0 and p < alpha/);
  assert.match(HELD_OUT_RULE.decision, /2\^H sign assignments/);
});
