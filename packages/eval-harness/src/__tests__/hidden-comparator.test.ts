import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureExpectations, compareObservations, runHiddenCheck } from '../index.js';

// R9-L4: three ways the comparator misjudged a correct solution. `doesNotThrow` was compared as if
// it were `throws`, so it passed exactly the solution that threw; `throws(fn, TypeError)` checked
// only that something was thrown, not what; and Maps and Sets were compared entry by entry, so two
// equal collections built in a different order failed. The expectations come from a trusted run,
// exactly as the store records them, and each test's bad solution fails for the reason stated.

async function repo(lib: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-comparator-'));
  await writeFile(path.join(dir, 'lib.js'), lib, 'utf8');
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

async function verdictFor(check: string, trusted: string, bad: string) {
  const good = await repo(trusted);
  let captured: Awaited<ReturnType<typeof captureExpectations>>;
  try {
    captured = await captureExpectations(check, good.dir);
  } finally {
    await good.cleanup();
  }
  assert.equal(captured.failure, undefined);
  const staged = await repo(bad);
  try {
    const run = await runHiddenCheck(check, staged.dir);
    assert.equal(run.failure, undefined);
    return { captured, verdict: compareObservations(run.observations, captured.expectations) };
  } finally {
    await staged.cleanup();
  }
}

const DOES_NOT_THROW = [
  "const assert = require('node:assert/strict');",
  "const { boom } = require('./lib');",
  'assert.doesNotThrow(() => boom(false));',
  '',
].join('\n');

test('doesNotThrow passes when nothing throws, and a solution that throws fails it', async () => {
  const trusted = 'module.exports = { boom: () => {} };\n';
  // The trusted run records one expectation: do not throw.
  const { captured, verdict } = await verdictFor(
    DOES_NOT_THROW,
    trusted,
    "module.exports = { boom: () => { throw new Error('boom called'); } };\n",
  );
  assert.equal(captured.expectations.length, 1);
  assert.equal(verdict.passed, false, 'a solution that throws passed doesNotThrow');
  assert.match(verdict.detail, /doesNotThrow saw Error: boom called/);
});

test('doesNotThrow passes the correct solution (the old comparator failed this)', async () => {
  const good = await repo('module.exports = { boom: () => {} };\n');
  try {
    const run = await runHiddenCheck(DOES_NOT_THROW, good.dir);
    assert.equal(run.failure, undefined);
    const captured = await captureExpectations(DOES_NOT_THROW, good.dir);
    assert.equal(captured.failure, undefined);
    assert.deepEqual(
      compareObservations(run.observations, captured.expectations),
      { passed: true, detail: 'the check made 1 assertion' },
    );
  } finally {
    await good.cleanup();
  }
});

const THROWS_TYPE = [
  "const assert = require('node:assert/strict');",
  "const { kind } = require('./lib');",
  "assert.throws(() => kind('type'), TypeError);",
  '',
].join('\n');

test('throws(fn, TypeError) checks the error type, not only that something was thrown', async () => {
  const trusted = "module.exports = { kind: () => { throw new TypeError('wrong kind'); } };\n";
  const { captured, verdict } = await verdictFor(
    THROWS_TYPE,
    trusted,
    "module.exports = { kind: () => { throw new RangeError('wrong kind'); } };\n",
  );
  // The constructor's name is part of the recorded contract.
  assert.equal(captured.expectations[0]?.errType, 'TypeError');
  assert.equal(verdict.passed, false, 'a RangeError passed a TypeError expectation');
  assert.match(verdict.detail, /threw RangeError, expected TypeError/);
});

const COLLECTIONS = [
  "const assert = require('node:assert/strict');",
  "const { entries, members } = require('./lib');",
  "assert.deepEqual(entries(), new Map([['b', 2], ['a', 1]]));",
  "assert.deepEqual(members(), new Set(['b', 'a']));",
  '',
].join('\n');

test('deepEqual compares Maps and Sets without regard to insertion order', async () => {
  // Built a-then-b; the check names b-then-a. Equal under node's deepStrictEqual.
  const trusted = [
    'module.exports = {',
    "  entries: () => new Map([['a', 1], ['b', 2]]),",
    "  members: () => new Set(['a', 'b']),",
    '};',
    '',
  ].join('\n');
  const good = await repo(trusted);
  let captured: Awaited<ReturnType<typeof captureExpectations>>;
  try {
    captured = await captureExpectations(COLLECTIONS, good.dir);
    assert.equal(captured.failure, undefined);
    const run = await runHiddenCheck(COLLECTIONS, good.dir);
    assert.equal(run.failure, undefined);
    assert.deepEqual(
      compareObservations(run.observations, captured.expectations),
      { passed: true, detail: 'the check made 2 assertions' },
    );
  } finally {
    await good.cleanup();
  }

  // The order-independent comparison is not a comparison that accepts anything.
  const different = await repo([
    'module.exports = {',
    "  entries: () => new Map([['a', 1], ['b', 3]]),",
    "  members: () => new Set(['a', 'c']),",
    '};',
    '',
  ].join('\n'));
  try {
    const run = await runHiddenCheck(COLLECTIONS, different.dir);
    assert.equal(run.failure, undefined);
    const verdict = compareObservations(run.observations, captured.expectations);
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /assertion 1: deepEqual/);
  } finally {
    await different.cleanup();
  }
});
