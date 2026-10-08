import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { Dag } from '@maf/types';
import { makeRunId } from '@maf/types';
import {
  DagRunner, DagParser, DagValidationError, validateDag, withRetry, DEFAULT_RETRY_POLICY,
} from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (D-06; audit P0 #10 and RetryOrchestrator.ts:10,23): a concurrency limit or an attempt
// count the scheduler cannot count up to is refused before anything runs. The old `< 1` test let
// NaN and a JSON string through — both compare false against 1 — and the dispatch loop then spun
// without ever awaiting; `maxAttempts: 0` skipped the retry loop and threw `undefined`.

const RUN_ID = makeRunId('scheduler-guards');
const ROLES = testRoleResolver(['coder'], 'coder');

type NodeSpec = Parameters<typeof DagParser.fromSpec>[0]['nodes'];
const ONE_NODE: NodeSpec = [{ id: 'a', label: 'a' }];

/**
 * Asserts validateDag refuses `dag` with `expected`. Called directly rather than through
 * `DagRunner.run` because the defect it guards against is a synchronous spin: a regression
 * would hang the test runner instead of failing it. run-outcome.test.ts holds that `run`
 * calls validateDag before dispatching anything.
 */
function assertInvalid(dag: Dag, expected: RegExp): void {
  assert.throws(
    () => validateDag(dag),
    (err: unknown) => err instanceof DagValidationError && expected.test(err.message),
  );
}

/** Runs `dag` and asserts it was refused with `expected` before any node was dispatched. */
async function assertRefused(dag: Dag, expected: RegExp): Promise<void> {
  let dispatched = 0;
  await assert.rejects(
    () => new DagRunner().run({
      dag,
      board: new BlackboardStore(),
      executor: async () => { dispatched++; return {}; },
    }),
    (err: unknown) => err instanceof DagValidationError && expected.test(err.message),
  );
  assert.equal(dispatched, 0, `no node may run when the DAG is refused for ${expected}`);
}

test('validateDag refuses a maxConcurrent that is not a positive safe integer', () => {
  const refusals: Array<[number, RegExp]> = [
    [Number.NaN, /^maxConcurrent must be a positive safe integer \(1 or more\), got NaN\.$/],
    [0, /got 0\.$/],
    [-1, /got -1\.$/],
    [1.5, /got 1\.5\.$/],
    [Number.POSITIVE_INFINITY, /got Infinity\.$/],
    [Number.MAX_SAFE_INTEGER + 1, /got 9007199254740992\.$/],
  ];

  for (const [maxConcurrent, expected] of refusals) {
    assertInvalid(
      DagParser.fromSpec({ id: 'x', nodes: ONE_NODE, config: { maxConcurrent } }, RUN_ID, ROLES),
      expected,
    );
  }
});

test('validateDag refuses a maxConcurrent written as a string in a JSON workflow spec', () => {
  // The static type says number; a hand-written WORKFLOW.md block does not have to agree.
  for (const [written, shown] of [['four', '"four"'], ['4', '"4"']] as const) {
    const dag = DagParser.fromYamlText(
      JSON.stringify({ id: 'x', nodes: [{ id: 'a', label: 'a' }], config: { maxConcurrent: written } }),
      RUN_ID,
      ROLES,
    );
    assertInvalid(
      dag,
      new RegExp(`maxConcurrent must be a positive safe integer \\(1 or more\\), got the string ${shown}\\.`),
    );
  }
});

test('a positive safe integer maxConcurrent is accepted — the refusals above are not blanket', async () => {
  for (const maxConcurrent of [1, 4, Number.MAX_SAFE_INTEGER]) {
    const outcome = await new DagRunner().run({
      dag: DagParser.fromSpec({ id: 'x', nodes: ONE_NODE, config: { maxConcurrent } }, RUN_ID, ROLES),
      board: new BlackboardStore(),
      executor: async () => ({}),
    });
    assert.equal(outcome.status, 'Succeeded', `maxConcurrent ${maxConcurrent} must run`);
  }
});

test('a node whose retry policy allows no attempt refuses the DAG before its sibling starts', async () => {
  const refusals: Array<[number, RegExp]> = [
    [0, /^node "b" retryPolicy\.maxAttempts must be a positive safe integer \(1 means no retry\), got 0\.$/],
    [-1, /got -1\.$/],
    [Number.NaN, /got NaN\.$/],
    [1.5, /got 1\.5\.$/],
  ];

  for (const [maxAttempts, expected] of refusals) {
    const nodes: NodeSpec = [{ id: 'a', label: 'a' }, { id: 'b', label: 'b', retry: { maxAttempts } }];
    await assertRefused(DagParser.fromSpec({ id: 'x', nodes }, RUN_ID, ROLES), expected);
  }
});

test('withRetry refuses a policy that allows no attempt, without calling the function', async () => {
  for (const maxAttempts of [0, -1, Number.NaN, 1.5]) {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; return 'ran'; }, { ...DEFAULT_RETRY_POLICY, maxAttempts }),
      // Not `undefined`: a refusal that says which field was wrong and what it held.
      (err: unknown) =>
        err instanceof RangeError &&
        /^Retry policy maxAttempts must be a positive safe integer \(1 means no retry\), got /.test(err.message),
    );
    assert.equal(calls, 0, `maxAttempts ${maxAttempts} must not run the function`);
  }
});
