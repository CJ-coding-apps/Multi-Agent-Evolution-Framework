import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoldenSuiteResult } from '@maf/eval-harness';
import { goldenRunStatus } from '../commands/goldens.js';

// ORACLE: IMPLEMENTATION_CHECKLIST_2026-09-25.md A4 (work order item 1) — the golden
// suite's outcome says whether the run EXECUTED, and the solve rate lives in its own
// field. Conflating them recorded every real run as "Failed" (an unsolved task is normal)
// and left the evolver unable to tell "the score was 9/10" from "the run broke".

function suite(results: Array<{ passed: boolean; errors: Array<string | undefined> }>): GoldenSuiteResult {
  return {
    harnessSha: 'a'.repeat(64),
    harnessId: 'h',
    ranAt: '1970-01-01T00:00:00.000Z',
    tasks: results.map((r, i) => ({
      taskId: `t${i}`,
      role: 'coder',
      passed: r.passed,
      attempts: r.errors.map((error, k) => ({
        attempt: k,
        output: '',
        outcomes: [],
        passed: r.passed,
        ...(error !== undefined ? { error } : {}),
      })),
    })),
    solvedTaskIds: results.flatMap((r, i) => (r.passed ? [`t${i}`] : [])),
  };
}

test('a run that measured 9 of 10 succeeded as a measurement', () => {
  const result = suite([
    ...Array.from({ length: 9 }, () => ({ passed: true, errors: [undefined] })),
    { passed: false, errors: [undefined] },
  ]);
  assert.equal(goldenRunStatus(result), 'Succeeded',
    'an unsolved task is a score, not a broken run');
});

test('a run whose attempt never reached its verifiers failed', () => {
  const result = suite([{ passed: false, errors: [undefined, 'cannot compute the golden diff'] }]);
  assert.equal(goldenRunStatus(result), 'Failed');
});

test('every task failing is still a successful measurement', () => {
  const result = suite([{ passed: false, errors: [undefined] }, { passed: false, errors: [undefined] }]);
  assert.equal(goldenRunStatus(result), 'Succeeded',
    '0/10 executed cleanly, which is exactly what the evolver needs to know');
});

test('the score is readable independently of the outcome', () => {
  const result = suite([{ passed: true, errors: [undefined] }, { passed: false, errors: [undefined] }]);
  assert.equal(goldenRunStatus(result), 'Succeeded');
  assert.deepEqual(result.solvedTaskIds, ['t0'], 'the solve rate is its own field');
  assert.equal(result.tasks.length, 2);
});
