import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_OUT_RULE, signFlipGate } from '../index.js';
import type { HeldOutTaskPasses } from '../index.js';

// ORACLE: D-57 / R3-G4 — the pre-registered test keeps its false-positive rate at or below alpha
// when there is no improvement, and its power against a real 3-of-10 gain is measured and recorded
// rather than assumed. The measured power is low (0.193), and the fragment reports that as a
// finding about the design; these tests pin the measurement so it cannot drift unnoticed.

const N = HELD_OUT_RULE.runs;
const TASKS = 10;

/** Deterministic uniform [0, 1) — a seeded PRNG, so the measured rates are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One simulated session: `runs` Bernoulli passes per task and per harness at the true rates. */
function session(
  rand: () => number, baseRates: readonly number[], candidateRates: readonly number[],
): HeldOutTaskPasses[] {
  const passes = (rates: readonly number[]): number[] =>
    rates.map((rate) => Array.from({ length: N }, () => rand() < rate).filter(Boolean).length);
  const base = passes(baseRates);
  const candidate = passes(candidateRates);
  return base.map((b, i) => ({ taskId: `t${i + 1}`, base: b, candidate: candidate[i]! }));
}

function rate(sessions: number, trueBase: readonly number[], trueCandidate: readonly number[], seed: number): number {
  const rand = mulberry32(seed);
  let improved = 0;
  for (let i = 0; i < sessions; i++)
    if (signFlipGate(session(rand, trueBase, trueCandidate)).improved) improved++;
  return improved / sessions;
}

// The shape the gate exists to catch: three tasks that improve from 30% to 80%, seven that do not.
const BASE = [...Array<number>(3).fill(0.3), ...Array<number>(7).fill(0.5)];
const CANDIDATE = [...Array<number>(3).fill(0.8), ...Array<number>(7).fill(0.5)];
const EQUAL = Array<number>(TASKS).fill(0.5);

test('power: the measured detection rate for a real 30%→80% gain on 3 of 10 tasks at N = 5', () => {
  const detection = rate(1000, BASE, CANDIDATE, 0x5eed);
  // Measured 0.193 over 1000 seeded sessions; recorded in the fragment. The structural ceiling is
  // the reason it is not higher: with only three tasks changing, the smallest achievable exact
  // p-value is 2^-3 = 0.125, so a session needs one of the other seven to move as well.
  assert.ok(detection >= 0.15, `detection rate ${detection} regressed below the measured shape`);
  assert.ok(detection < 0.5, 'a 3-of-10 gain is not detectable most of the time by design');
});

test('power: with no true difference the false-positive rate stays at or below alpha', () => {
  // Measured 0.030 over 1000 seeded sessions — the exact test is conservative, as a discrete test
  // must be. The requirement is only that it cannot exceed alpha.
  const falsePositive = rate(1000, EQUAL, EQUAL, 0x1234);
  assert.ok(falsePositive <= HELD_OUT_RULE.alpha,
    `false-positive rate ${falsePositive} exceeds alpha ${HELD_OUT_RULE.alpha}`);
});

test('power: the measurement is reproducible from its seed', () => {
  assert.equal(rate(200, BASE, CANDIDATE, 0x5eed), rate(200, BASE, CANDIDATE, 0x5eed));
});
