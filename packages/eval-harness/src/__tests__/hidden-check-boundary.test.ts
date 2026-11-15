import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureExpectations, compareObservations, runHiddenCheck } from '../index.js';

// R6-H2 / R7-H2 (D-57): the hidden check is judged across a process boundary. The verifier showed
// that a solution doing nothing but overwriting `node:assert`'s functions passed every check,
// because the check ran in the solution's own process. These tests are the refusal: the expected
// values stay in the checker, the solution's process only reports what the check observed, and
// nothing the solution does to its process — patching globals, printing a verdict, exiting early —
// can move the verdict. The last test proves the check really runs elsewhere.

const DOUBLE = 'module.exports = { double: (x) => x * 2 };\n';
const CHECK = [
  "const assert = require('node:assert/strict');",
  "const { double } = require('./lib');",
  'assert.equal(double(2), 4);',
  'assert.equal(double(-1), -2);',
  // The actual pid travels back as an observation's `a`; the expected value is the literal 0, so
  // the assertion's result does not depend on which process ran it.
  'assert.notEqual(process.pid, 0);',
  '',
].join('\n');
// A check written as an async IIFE: its assertions happen after an await, and its completion value
// is the promise. The driver must await it — two corpus tasks end this way and scored zero
// assertions until it did.
const ASYNC_CHECK = [
  "const assert = require('node:assert/strict');",
  "const { double } = require('./lib');",
  '(async () => {',
  '  await new Promise((resolve) => setTimeout(resolve, 20));',
  '  assert.equal(double(2), 4);',
  '  assert.deepEqual([double(1)], [2]);',
  '})().catch((e) => { console.error(e); process.exit(1); });',
  '',
].join('\n');
const EXIT_STYLE = [
  "const { double } = require('./lib');",
  'if (double(2) !== 4) { console.error("broken"); process.exit(1); }',
  '',
].join('\n');

async function repo(lib: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-boundary-'));
  await writeFile(path.join(dir, 'lib.js'), lib, 'utf8');
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

/** The expected values come from a trusted run, exactly as the store build records them. */
async function expectationsOf(check: string): Promise<ReturnType<typeof captureExpectations>> {
  const trusted = await repo(DOUBLE);
  try {
    return await captureExpectations(check, trusted.dir);
  } finally {
    await trusted.cleanup();
  }
}

test('the boundary: a correct solution produces exactly the recorded observations', async () => {
  const captured = await expectationsOf(CHECK);
  assert.equal(captured.failure, undefined);
  assert.equal(captured.expectations.length, 3);

  const staged = await repo(DOUBLE);
  try {
    const run = await runHiddenCheck(CHECK, staged.dir);
    assert.equal(run.failure, undefined);
    const verdict = compareObservations(run.observations, captured.expectations);
    assert.deepEqual(verdict, { passed: true, detail: 'the check made 3 assertions' });
    // The third observation's actual value is the checking process's pid.
    const pid = run.observations[2]?.a;
    assert.equal(typeof pid, 'number');
    assert.notEqual(pid, process.pid, 'the check ran in the test process');
  } finally {
    await staged.cleanup();
  }
});

test('a solution that disables node:assert fails the check it tried to switch off', async () => {
  const captured = await expectationsOf(CHECK);
  const disabling = [
    "const assert = require('node:assert');",
    "const strict = require('node:assert/strict');",
    'for (const m of Object.keys(assert)) { assert[m] = () => {}; strict[m] = () => {}; }',
    'module.exports = { double: () => 0 };',
    '',
  ].join('\n');
  const staged = await repo(disabling);
  try {
    const run = await runHiddenCheck(CHECK, staged.dir);
    assert.equal(run.failure, undefined);
    const verdict = compareObservations(run.observations, captured.expectations);
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /assertion 1: equal saw 0, expected 4/);
  } finally {
    await staged.cleanup();
  }
});

test('a solution that prints its own PASS verdict fails', async () => {
  const captured = await expectationsOf(CHECK);
  const staged = await repo(
    "console.log('PASS'); process.stdout.write('ok 3 - all tests passed\\n');\nmodule.exports = { double: () => 0 };\n",
  );
  try {
    const run = await runHiddenCheck(CHECK, staged.dir);
    assert.equal(run.failure, undefined);
    const verdict = compareObservations(run.observations, captured.expectations);
    assert.equal(verdict.passed, false);
  } finally {
    await staged.cleanup();
  }
});

test('a solution that exits the process early fails, whatever code it exits with', async () => {
  const captured = await expectationsOf(CHECK);
  for (const code of [0, 1]) {
    const staged = await repo(`process.exit(${code});\nmodule.exports = { double: (x) => x * 2 };\n`);
    try {
      const run = await runHiddenCheck(CHECK, staged.dir);
      assert.notEqual(run.failure, undefined, `process.exit(${code}) was accepted as a verdict`);
      assert.equal(compareObservations(run.observations, captured.expectations).passed, false);
    } finally {
      await staged.cleanup();
    }
  }
});

test('the child cannot answer for the checker: a malformed observation line fails the check', async () => {
  const captured = await expectationsOf(CHECK);
  // A check whose own assertion call is fine but which writes a forged line to the driver's pipe.
  const forged = [
    'const fs = require("node:fs");',
    'try { fs.writeSync(3, JSON.stringify({ op: "equal", loose: false, a: 1, e: 1 }) + "\\n"); } catch (e) {}',
    "const assert = require('node:assert/strict');",
    "assert.equal(require('./lib').double(2), 4);",
    '',
  ].join('\n');
  const staged = await repo(DOUBLE);
  try {
    const run = await runHiddenCheck(forged, staged.dir);
    // Anything the pipe carries that the driver did not write is either ignored (wrong nonce) or a
    // failure. Either way the forged observation is not counted as the check's own.
    if (run.failure === undefined)
      assert.equal(compareObservations(run.observations, captured.expectations).passed, false);
  } finally {
    await staged.cleanup();
  }
});

test('an async check is awaited before the driver reports done', async () => {
  const captured = await expectationsOf(ASYNC_CHECK);
  assert.equal(captured.failure, undefined);
  assert.equal(captured.expectations.length, 2);

  const good = await repo(DOUBLE);
  try {
    const run = await runHiddenCheck(ASYNC_CHECK, good.dir);
    assert.equal(run.failure, undefined);
    assert.equal(compareObservations(run.observations, captured.expectations).passed, true);
  } finally {
    await good.cleanup();
  }

  const bad = await repo('module.exports = { double: () => 7 };\n');
  try {
    const run = await runHiddenCheck(ASYNC_CHECK, bad.dir);
    assert.equal(compareObservations(run.observations, captured.expectations).passed, false);
  } finally {
    await bad.cleanup();
  }
});

test('an exit-status check passes when the solution leaves it alone and fails when it trips it', async () => {
  const captured = await expectationsOf(EXIT_STYLE);
  assert.equal(captured.failure, undefined);
  assert.deepEqual(captured.expectations, []);
  assert.equal(captured.exitStyle, true);

  const good = await repo(DOUBLE);
  try {
    const run = await runHiddenCheck(EXIT_STYLE, good.dir);
    assert.equal(run.failure, undefined);
    assert.deepEqual(run.observations, []);
    assert.equal(compareObservations(run.observations, captured.expectations).passed, true);
  } finally {
    await good.cleanup();
  }

  const bad = await repo('module.exports = { double: () => 0 };\n');
  try {
    const run = await runHiddenCheck(EXIT_STYLE, bad.dir);
    assert.equal(run.failure, undefined);
    assert.equal(run.observations[0]?.op, 'exit');
    assert.equal(compareObservations(run.observations, captured.expectations).passed, false);
  } finally {
    await bad.cleanup();
  }
});
