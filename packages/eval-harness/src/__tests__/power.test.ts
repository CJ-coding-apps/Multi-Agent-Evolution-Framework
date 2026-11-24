import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_OUT_RULE, stratifiedGate } from '../index.js';
import type { HeldOutTaskPasses } from '../index.js';

// ORACLE: D-57 / R4-A5 — the pre-registered design's power and false-positive rate are MEASURED,
// not assumed: H = 20 tasks, N = 10 single attempts each, the exact stratified gate, 2000
// simulated sessions per shape. The numbers this file measures are the ones recorded in
// `docs/changes/WP-3.7b.md` (R4-A5). No harness, no model, no spend.

const N = HELD_OUT_RULE.runs;
const TASKS = HELD_OUT_RULE.minTasks;
/** CJ's round-4 brief: at least 2000 sessions per scenario. */
const SESSIONS = 2000;

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

function rate(
  sessions: number, trueBase: readonly number[], trueCandidate: readonly number[], seed: number,
): number {
  const rand = mulberry32(seed);
  let improved = 0;
  for (let i = 0; i < sessions; i++)
    if (stratifiedGate(session(rand, trueBase, trueCandidate)).improved) improved++;
  return improved / sessions;
}

/**
 * The specified effect: 6 of the 20 tasks (30%) move from 30% to 80%; the other 14 are unchanged
 * at 50%. This is the round-3 shape the verifier measured, moved to the round-4 design.
 */
const SPEC_BASE = [...Array<number>(6).fill(0.3), ...Array<number>(TASKS - 6).fill(0.5)];
const SPEC_CANDIDATE = [...Array<number>(6).fill(0.8), ...Array<number>(TASKS - 6).fill(0.5)];
/** A broad but small effect: 60% of the tasks improve by +0.2 (0.5 → 0.7), the rest flat at 50%. */
const BROAD_BASE = Array<number>(TASKS).fill(0.5);
const BROAD_CANDIDATE = [...Array<number>(12).fill(0.7), ...Array<number>(TASKS - 12).fill(0.5)];
/** No true difference anywhere: every task at 50% under both harnesses. */
const EQUAL = Array<number>(TASKS).fill(0.5);

test('power: a 30%→80% gain on 30% of the tasks is detected at least 8 times in 10 (R4-A5)', () => {
  // Measured 1816/2000 = 0.908 (seed 0x5eed); a second seed gives 0.9035. The brief's floor is 0.8.
  const detection = rate(SESSIONS, SPEC_BASE, SPEC_CANDIDATE, 0x5eed);
  assert.ok(detection >= 0.8, `detection rate ${detection} is below the designed power`);
  assert.ok(Math.abs(detection - rate(SESSIONS, SPEC_BASE, SPEC_CANDIDATE, 0x9999)) <= 0.03,
    'the measurement is a property of the design, not of the seed');
});

test('power: a broad +0.2 on 60% of the tasks is detected about 3 times in 4 (R4-A5, reported)', () => {
  // Measured 1492/2000 = 0.746 (seed 0xbeef); a second seed gives 0.7565. The brief asks for this
  // number to be REPORTED, not to clear 0.8 — a +0.2 move on 12 of 20 tasks is what it is.
  const detection = rate(SESSIONS, BROAD_BASE, BROAD_CANDIDATE, 0xbeef);
  assert.ok(detection >= 0.7 && detection < 0.8, `broad detection rate ${detection} moved out of the measured band`);
  assert.ok(Math.abs(detection - rate(SESSIONS, BROAD_BASE, BROAD_CANDIDATE, 0x4242)) <= 0.03,
    'the measurement is a property of the design, not of the seed');
});

test('power: with no true difference the false-positive rate stays at or below alpha (R4-A5)', () => {
  // Measured 83/2000 = 0.0415. A discrete exact test cannot spend more level than alpha has.
  const falsePositive = rate(SESSIONS, EQUAL, EQUAL, 0x1234);
  assert.ok(falsePositive <= HELD_OUT_RULE.alpha,
    `false-positive rate ${falsePositive} exceeds alpha ${HELD_OUT_RULE.alpha}`);
});

test('power: the measurement is reproducible from its seed', () => {
  assert.equal(rate(50, SPEC_BASE, SPEC_CANDIDATE, 0x5eed), rate(50, SPEC_BASE, SPEC_CANDIDATE, 0x5eed));
});
