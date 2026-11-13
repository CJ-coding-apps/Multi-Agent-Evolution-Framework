import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_OUT_RULE, stratifiedGate } from '../index.js';
import type { HeldOutTaskPasses } from '../index.js';

// ORACLE: D-57 / R3-G4 — the pre-registered test keeps its false-positive rate at or below alpha
// when there is no improvement, and its power against a real gain is measured rather than assumed.
// R4-A1 moved the design to the stratified within-task test at N = 10 on 20 tasks; the full
// measurement (≥ 2000 sessions per scenario, with the numbers recorded in the fragment) is R4-A5.

const N = HELD_OUT_RULE.runs;
const TASKS = HELD_OUT_RULE.minTasks;

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

// The shape the gate exists to catch: 30% of the tasks (6 of 20) improve from 30% to 80%, the rest
// are unchanged at 50%.
const BASE = [...Array<number>(6).fill(0.3), ...Array<number>(TASKS - 6).fill(0.5)];
const CANDIDATE = [...Array<number>(6).fill(0.8), ...Array<number>(TASKS - 6).fill(0.5)];
const EQUAL = Array<number>(TASKS).fill(0.5);

test('power: a real 30%→80% gain on 30% of the tasks is detected', () => {
  const detection = rate(200, BASE, CANDIDATE, 0x5eed);
  assert.ok(detection >= 0.8, `detection rate ${detection} is below the designed power`);
});

test('power: with no true difference the false-positive rate stays at or below alpha', () => {
  const falsePositive = rate(200, EQUAL, EQUAL, 0x1234);
  assert.ok(falsePositive <= HELD_OUT_RULE.alpha,
    `false-positive rate ${falsePositive} exceeds alpha ${HELD_OUT_RULE.alpha}`);
});

test('power: the measurement is reproducible from its seed', () => {
  assert.equal(rate(50, BASE, CANDIDATE, 0x5eed), rate(50, BASE, CANDIDATE, 0x5eed));
});
