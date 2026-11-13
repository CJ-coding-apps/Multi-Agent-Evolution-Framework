import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_MAX_SELECTED, CALIBRATION_MIN_SELECTED, CALIBRATION_RULE, CALIBRATION_RUNS,
  CALIBRATION_SELECTION_SEED, CalibrationError, HELD_OUT_RULE, applyCalibration, selectCalibrated,
} from '../index.js';
import type { CalibrationCount, CorpusSplits } from '../index.js';

// ORACLE: D-57 / R3-G2 — the calibration selection rule is fixed in code, pre-registered for three
// runs, and the edit it makes to the split is a consequence of the counts, not a preference.

const c = (taskId: string, passes: number): CalibrationCount => ({ taskId, passes, attempts: CALIBRATION_RUNS });

test('calibration: the rule keeps 0/3, 1/3 and 2/3 tasks, drops 3/3, and caps the never-solved at a third', () => {
  // partial = 2 (c, d) => at most floor(2/2) = 1 never-solved task is kept; b survives (pool order),
  // e is dropped. a has no headroom.
  const counts = [c('a', 3), c('b', 0), c('c', 1), c('d', 2), c('e', 0)];
  const sel = selectCalibrated(counts);
  assert.deepEqual(sel.selected, ['b', 'c', 'd'], 'selected in pool order, capped at one never-solved');
  assert.deepEqual(sel.droppedAlwaysSolved, ['a']);
  assert.deepEqual(sel.droppedAlwaysFailed, ['e']);
  assert.equal(sel.zerosAllowed, 1);
  assert.equal(sel.zerosKept, 1);
  assert.equal(sel.qualified, false, 'three tasks cannot qualify');
  assert.match(sel.reason ?? '', /only 3 tasks qualified/);
  // The cap is the arithmetic "at most a third of the kept set is 0/3".
  assert.ok(sel.zerosKept * 3 <= sel.selected.length);
});

test('calibration: enough tasks qualify, the never-solved cap binds, and an over-full pool is sampled to 20', () => {
  const counts = [
    ...Array.from({ length: 16 }, (_, i) => c(`p${i}`, i % 2 === 0 ? 1 : 2)),
    ...Array.from({ length: 10 }, (_, i) => c(`z${i}`, 0)),
  ];
  const sel = selectCalibrated(counts);
  // R4-A3: 24 qualify (16 partial + 8 never-solved); the yardstick is exactly CALIBRATION_MAX_SELECTED.
  assert.equal(sel.qualifiedIds.length, 16 + Math.floor(16 / 2));
  assert.equal(sel.zerosAllowed, 8);
  // The sample is drawn within the strata, so the "third" cap still holds of the kept 20.
  assert.equal(sel.zerosKept, Math.floor(CALIBRATION_MAX_SELECTED / 3));
  assert.deepEqual(sel.droppedAlwaysFailed, ['z8', 'z9'], 'the never-solved tasks beyond the cap stay in the pool');
  assert.equal(sel.notDrawn.length, 4, 'qualified but not drawn: reported, not silently dropped');
  assert.equal(sel.selected.length, CALIBRATION_MAX_SELECTED);
  assert.equal(sel.sampled, true);
  assert.equal(sel.seed, CALIBRATION_SELECTION_SEED);
  assert.equal(sel.qualified, true);
  assert.deepEqual(sel.selected, [...sel.selected].sort(), 'a sampled set is listed in id order');
  assert.ok(sel.zerosKept * 3 <= sel.selected.length);
});

test('calibration: the over-full choice is a function of the counts — same seed, same 20, in id order', () => {
  const counts = Array.from({ length: 35 }, (_, i) => c(`t${String(i).padStart(2, '0')}`, 1));
  const a = selectCalibrated(counts);
  const b = selectCalibrated([...counts].reverse());
  assert.equal(a.selected.length, CALIBRATION_MAX_SELECTED);
  assert.deepEqual(a.selected, b.selected, 'the pool order does not change which 20 are kept');
  assert.deepEqual(a.selected, [...a.selected].sort());
  // Not simply the first 20 in pool order: the choice is a shuffle, or this test proves nothing.
  assert.notDeepEqual(a.selected, a.qualifiedIds.slice(0, CALIBRATION_MAX_SELECTED));
});

test('calibration: exactly the floor qualifies, one fewer does not', () => {
  const at = Array.from({ length: CALIBRATION_MIN_SELECTED }, (_, i) => c(`t${i}`, 1));
  assert.equal(selectCalibrated(at).selected.length, CALIBRATION_MIN_SELECTED);
  assert.equal(selectCalibrated(at).qualified, true);
  const under = selectCalibrated(at.slice(0, CALIBRATION_MIN_SELECTED - 1));
  assert.equal(under.qualified, false);
  assert.match(under.reason ?? '', new RegExp(`needs at least ${CALIBRATION_MIN_SELECTED}`));
  // A never-solved bucket on its own qualifies nothing: the cap for zero partial tasks is zero.
  const zeros = selectCalibrated(Array.from({ length: 20 }, (_, i) => c(`z${i}`, 0)));
  assert.deepEqual(zeros.selected, []);
  assert.equal(zeros.zerosAllowed, 0);
  assert.equal(zeros.qualified, false);
  // Nor does a pool the base always solves: there is no headroom to measure.
  const solved = selectCalibrated(Array.from({ length: 20 }, (_, i) => c(`s${i}`, 3)));
  assert.deepEqual(solved.selected, []);
  assert.equal(solved.droppedAlwaysSolved.length, 20);
  assert.equal(solved.qualified, false);
});

test('calibration: the rule is fixed — a different run count, a duplicate or an impossible count is refused', () => {
  for (const attempts of [2, 4]) {
    assert.throws(() => selectCalibrated([{ taskId: 'x', passes: 1, attempts }]),
      (err: unknown) => err instanceof CalibrationError && /pre-registered for 3/.test(err.message));
  }
  assert.throws(() => selectCalibrated([c('x', 1), c('x', 2)]), /calibration counts list x more than once/);
  assert.throws(() => selectCalibrated([{ taskId: 'x', passes: 4, attempts: 3 }]), /has 4 passes of 3/);
  assert.throws(() => selectCalibrated([{ taskId: 'x', passes: -1, attempts: 3 }]), /has -1 passes of 3/);
  assert.throws(() => selectCalibrated([{ taskId: 'x', passes: 1.5, attempts: 3 }]), /has 1.5 passes of 3/);
});

test('calibration: the committed rule text states the rule the code implements', () => {
  assert.match(CALIBRATION_RULE, /0, 1 or 2 of 3/);
  assert.match(CALIBRATION_RULE, /at most a third of the kept set may be 0 of 3/);
  assert.match(CALIBRATION_RULE, new RegExp(`at least ${CALIBRATION_MIN_SELECTED} must qualify`));
  assert.match(CALIBRATION_RULE, new RegExp(
    `when more than ${CALIBRATION_MAX_SELECTED} qualify, ${CALIBRATION_MAX_SELECTED} are drawn by a ` +
    `fixed-seed shuffle \\(seed ${CALIBRATION_SELECTION_SEED}\\)`));
});

test('calibration: applying it REPLACES heldOut, retires the old set to train, and leaves the rest pooled', () => {
  const splits: CorpusSplits = {
    version: 1, minHeldOut: 5, gate: HELD_OUT_RULE,
    preRegistration: { attempts: 'single', selection: CALIBRATION_RULE, calibrationSha: null },
    train: ['t1', 't2'],
    heldOut: ['h1', 'h2', 'h3', 'h4', 'h5'],
    pool: ['p1', 'p2', 'p3', 'p4'],
  };
  // Two partial tasks allow one never-solved; p2 is kept because it comes first in pool order.
  const sel = selectCalibrated([c('p1', 1), c('p2', 0), c('p3', 2), c('p4', 0)]);
  assert.deepEqual(sel.selected, ['p1', 'p2', 'p3']);
  const next = applyCalibration(splits, sel);
  // R4-A3: the calibrated set is the yardstick, not an addition to the old one (round-3 L1).
  assert.deepEqual(next.heldOut, ['p1', 'p2', 'p3']);
  assert.deepEqual(next.train, ['t1', 't2', 'h1', 'h2', 'h3', 'h4', 'h5'],
    'the retired held-out tasks stay in the corpus as training tasks, never as yardstick');
  assert.deepEqual(next.pool, ['p4']);
  assert.equal(next.minHeldOut, 5);
  // R4-A4: a calibrated split names the measurement it came from; without one the field is untouched.
  assert.equal(next.preRegistration.calibrationSha, null);
  assert.equal(applyCalibration(splits, sel, 'c'.repeat(64)).preRegistration.calibrationSha, 'c'.repeat(64));
  // The split must be re-read as a partition after the edit; an id it invents would fail here.
  assert.throws(() => applyCalibration(splits, { ...sel, selected: ['h1'] }),
    /calibration selected h1, which is not in the pool/);
  assert.throws(() => applyCalibration(splits, { ...sel, selected: ['p1', 'p1'] }), /more than once/);
});
