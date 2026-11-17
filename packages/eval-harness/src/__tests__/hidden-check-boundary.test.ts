import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureExpectations, compareObservations, injectCanary, runHiddenCheck } from '../index.js';

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

/* ---------- R8-H1: the child receives call descriptions, never the check ---------- */

// The verifier's round-7 exploit: the whole check, expected literals and canary included, was sent
// into the solution's process, and a solution that implemented nothing read it out of its caller's
// frame (`fn.caller.arguments[0]`) and replayed the answers. Now the check never leaves this
// process: the child is told which function to call and with which inputs, as data. This solution
// tries the same trick and can only return what it can actually compute.
const REPLAY_CHECK = [
  "const assert = require('node:assert/strict');",
  "const { Lru } = require('./lib');",
  'const cache = new Lru(2);',
  "cache.set('a', 1);",
  "cache.set('b', 2);",
  "cache.set('c', 3);",
  // Expected values that are never passed to the solution as inputs: an evicted key, and the value
  // that survived. Reading either out of this file is exactly what the exploit did.
  "assert.equal(cache.get('a'), undefined);",
  "assert.equal(cache.get('c'), 3);",
  '',
].join('\n');

const REPLAY_SOLUTION = [
  '// The verifier\'s no-op: it implements no cache at all. It walks its caller frames for the check',
  '// source, parses the expected value out of `cache.get(KEY), <value>)`, and replays it.',
  'function harvest() {',
  '  var text = "";',
  '  try {',
  '    var frame = harvest.caller;',
  '    for (var i = 0; i < 8 && frame; i++) {',
  '      try {',
  '        var args = frame.arguments;',
  '        if (args) for (var j = 0; j < args.length; j++) if (typeof args[j] === "string") text += args[j] + "\\n";',
  '      } catch (e) { /* a strict frame has no arguments */ }',
  '      try { frame = frame.caller; } catch (e) { frame = null; }',
  '    }',
  '  } catch (e) { /* no caller chain at all */ }',
  '  return text.indexOf("assert.equal") < 0 ? null : text;',
  '}',
  'function Lru(limit) { this.limit = limit; }',
  'Lru.prototype.set = function () { return this; };',
  'Lru.prototype.get = function (key) {',
  '  var source = harvest();',
  '  if (source === null) return undefined;',
  '  var match = source.match(new RegExp("cache\\\\.get\\\\(\'\" + key + "\'\\),\\s*([^)]+)\\)"));',
  '  if (!match) return undefined;',
  '  var literal = match[1].trim();',
  '  return literal === "undefined" ? undefined : Number(literal);',
  '};',
  'module.exports = { Lru: Lru };',
  '',
].join('\n');

test('a solution that replays what it reads out of its caller finds nothing, and fails', async () => {
  const reference = await repo([
    'class Lru {',
    '  constructor(limit) { this.limit = limit; this.map = new Map(); }',
    '  set(key, value) { this.map.delete(key); this.map.set(key, value);',
    '    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value); return this; }',
    '  get(key) { return this.map.get(key); }',
    '}',
    'module.exports = { Lru };',
    '',
  ].join('\n'));
  let captured: Awaited<ReturnType<typeof captureExpectations>>;
  try {
    captured = await captureExpectations(REPLAY_CHECK, reference.dir);
  } finally {
    await reference.cleanup();
  }
  assert.equal(captured.failure, undefined);
  assert.equal(captured.expectations.length, 2);

  const replay = await repo(REPLAY_SOLUTION);
  try {
    const run = await runHiddenCheck(REPLAY_CHECK, replay.dir);
    assert.equal(run.failure, undefined);
    const verdict = compareObservations(run.observations, captured.expectations);
    assert.equal(verdict.passed, false, 'a solution that computed nothing passed');
    // It reached the second assertion with nothing to replay: the eviction answer it needed was
    // never in its process to read.
    assert.match(verdict.detail, /assertion 2: equal saw \{"t":"u"\}, expected 3/);
  } finally {
    await replay.cleanup();
  }
});

// The scan is the mutant-killer for "the check source sent to the child again": if any part of the
// check — a literal or the store's canary — reaches the child's process, this solution finds it in
// what it can see (argv, the environment, the globals, its own stdin) and the check fails.
const SCAN_CHECK = [
  "const assert = require('node:assert/strict');",
  "const { scan } = require('./lib');",
  '// SENTINEL-R8H1-9d2b41 is an expected value of this file and nothing else.',
  "assert.equal(scan('INPUT-R8H1-77aa'), 'saw:INPUT-R8H1-77aa');",
  "assert.equal(scan(), 'clean');",
  '',
].join('\n');

const SCAN_SOLUTION = [
  'const fs = require("node:fs");',
  'function surface() {',
  '  const parts = [];',
  '  for (const arg of process.argv) parts.push(String(arg));',
  '  for (const key of Object.keys(process.env)) parts.push(String(process.env[key]));',
  '  for (const key of Object.getOwnPropertyNames(globalThis)) {',
  '    let value;',
  '    try { value = globalThis[key]; } catch (e) { continue; }',
  '    if (typeof value === "string") parts.push(value);',
  '    else if (typeof value === "function") {',
  '      try { parts.push(Function.prototype.toString.call(value)); } catch (e) { /* native */ }',
  '    }',
  '  }',
  '  try { parts.push(String(process.title)); } catch (e) { /* gone */ }',
  '  // The driver reads its configuration from stdin once; nothing of the check is there.',
  '  try { parts.push(String(fs.readFileSync(0, "utf8"))); } catch (e) { /* closed */ }',
  '  return parts.join("\\n");',
  '}',
  'function scan(input) {',
  '  if (input !== undefined) return "saw:" + input;',
  '  const text = surface();',
  '  if (text.includes("SENTINEL-R8H1-9d2b41")) return "LEAK:sentinel";',
  '  if (text.includes("maf-hidden-canary-")) return "LEAK:canary";',
  '  return "clean";',
  '}',
  'module.exports = { scan };',
  '',
].join('\n');

test('a solution that searches everything it can see finds no expected value and no canary', async () => {
  // The store injects the canary as the first line of every hidden file; the scan looks for it too.
  const check = injectCanary(SCAN_CHECK, 'r8-scan', '.checks/scan.js');
  const reference = await repo("module.exports = { scan: (input) => input === undefined ? 'clean' : 'saw:' + input };\n");
  let captured: Awaited<ReturnType<typeof captureExpectations>>;
  try {
    captured = await captureExpectations(check, reference.dir);
  } finally {
    await reference.cleanup();
  }
  assert.equal(captured.failure, undefined);
  assert.deepEqual(captured.expectations, [
    { op: 'equal', loose: false, e: 'saw:INPUT-R8H1-77aa' },
    { op: 'equal', loose: false, e: 'clean' },
  ]);

  const searching = await repo(SCAN_SOLUTION);
  try {
    const run = await runHiddenCheck(check, searching.dir);
    assert.equal(run.failure, undefined);
    // The first answer proves the scan saw what it was given: the check is not vacuous.
    assert.equal(run.observations[0]?.a, 'saw:INPUT-R8H1-77aa');
    assert.equal(run.observations[1]?.a, 'clean', 'the child could see part of the check');
    assert.equal(compareObservations(run.observations, captured.expectations).passed, true);
  } finally {
    await searching.cleanup();
  }
});

/* ---------- R8-L2: the scan also covers the child's heap ---------- */

// The sweep above reads what the solution can *reach* by name — argv, environment, globals, stdin.
// It cannot see a string that is alive in the child's heap and reachable only through a closure,
// which is exactly how a leaked check source would sit if the boundary ever regressed. These two
// runs use a heap snapshot written from inside the child and searched by the test:
//
//  - the control holds the sentinel in a driver-side closure; the snapshot must contain it, or the
//    scan is blind and a clean result means nothing;
//  - the real run holds an inert marker instead — the snapshot must contain that marker, and must
//    not contain the sentinel or the canary.
//
// The markers are assembled at runtime from character codes, so no copy of either string exists in
// the solution's source; a snapshot hit can only come from the closure.

const HEAP_CHECK = [
  "const assert = require('node:assert/strict');",
  "const { scan, heapFile } = require('./lib');",
  '// SENTINEL-R8H1-9d2b41 is an expected value of this file and nothing else.',
  "assert.equal(scan('INPUT-R8H1-77aa'), 'saw:INPUT-R8H1-77aa');",
  // The path of the snapshot crosses as an ordinary string; the test reads the file.
  "assert.notEqual(heapFile(), '');",
  '',
].join('\n');

function heapSolution(held: string): string {
  const codes = Array.from(held, (c) => c.codePointAt(0)).join(', ');
  return [
    'const v8 = require("node:v8");',
    'const fs = require("node:fs");',
    'const os = require("node:os");',
    'const path = require("node:path");',
    'function hold(codes) {',
    '  const s = String.fromCharCode.apply(null, codes);',
    '  return function () { return s; };',
    '}',
    'module.exports.held = hold([' + codes + ']);',
    'function scan(input) {',
    '  if (input !== undefined) return "saw:" + input;',
    '  return "clean";',
    '}',
    'function heapFile() {',
    '  const keep = module.exports.held;', // on the stack at snapshot time, so the closure is a root
    '  const file = path.join(os.tmpdir(), "maf-r9l2-" + process.pid + ".heapsnapshot");',
    '  v8.writeHeapSnapshot(file);',
    '  return typeof keep === "function" ? file : "";',
    '}',
    'module.exports.scan = scan;',
    'module.exports.heapFile = heapFile;',
    '',
  ].join('\n');
}

async function snapshotText(observations: Array<{ a?: unknown }>): Promise<{ text: string; file: string }> {
  const file = observations[1]?.a;
  assert.equal(typeof file, 'string', 'the child did not report a heap snapshot path');
  const text = await readFile(file as string, 'utf8');
  await rm(file as string, { force: true });
  return { text, file: file as string };
}

test("the scan covers the child's heap, and a closure-held sentinel would be seen", async () => {
  const check = injectCanary(HEAP_CHECK, 'r9l2-scan', '.checks/scan-heap.js');
  const reference = await repo(
    "module.exports = { scan: (i) => 'saw:' + i, heapFile: () => '/dev/null' };\n",
  );
  let captured: Awaited<ReturnType<typeof captureExpectations>>;
  try {
    captured = await captureExpectations(check, reference.dir);
  } finally {
    await reference.cleanup();
  }
  assert.equal(captured.failure, undefined);

  const run = async (held: string) => {
    const staged = await repo(heapSolution(held));
    try {
      const result = await runHiddenCheck(check, staged.dir);
      assert.equal(result.failure, undefined);
      assert.equal(result.observations[0]?.a, 'saw:INPUT-R8H1-77aa');
      return result;
    } finally {
      await staged.cleanup();
    }
  };

  // Positive control: the sentinel lives only in a closure in the child's heap. If the snapshot
  // does not show it, the scan below would be green for the wrong reason.
  const control = await snapshotText((await run('SENTINEL-R8H1-9d2b41')).observations as Array<{ a?: unknown }>);
  assert.ok(control.text.includes('SENTINEL-R8H1-9d2b41'),
    'a closure-held marker was not in the heap snapshot: the scan cannot see a leaked check');

  // The real run. The inert marker proves the snapshot was readable and searched; the sentinel and
  // the canary must not appear anywhere in it.
  const real = await run('CLEAN-CONTROL-R9L2');
  assert.equal(compareObservations(real.observations, captured.expectations).passed, true);
  const heap = await snapshotText(real.observations as Array<{ a?: unknown }>);
  assert.ok(heap.text.includes('CLEAN-CONTROL-R9L2'), 'the snapshot did not show the marker the child holds');
  assert.equal(heap.text.includes('SENTINEL-R8H1-9d2b41'), false, 'the check source reached the child heap');
  assert.equal(heap.text.includes('maf-hidden-canary-'), false, 'the canary reached the child heap');
});

/* ---------- R8-L1: the scorer reads a bounded amount of the solution's output ---------- */

test('a solution that answers with more than one message may carry fails, and is killed', async () => {
  const check = [
    "const assert = require('node:assert/strict');",
    "const { huge } = require('./lib');",
    "assert.equal(huge(), 'small');",
    '',
  ].join('\n');
  const staged = await repo("module.exports = { huge: () => 'A'.repeat(2 * 1024 * 1024) };\n");
  try {
    const run = await runHiddenCheck(check, staged.dir, { timeoutMs: 20_000 });
    assert.match(String(run.failure), /larger than 1048576 bytes/);
  } finally {
    await staged.cleanup();
  }
});

test('a solution that keeps answering just under the cap still runs out of total budget', async () => {
  const check = [
    "const assert = require('node:assert/strict');",
    "const { big } = require('./lib');",
    'for (let i = 0; i < 12; i++) assert.equal(big(), "small");',
    '',
  ].join('\n');
  const staged = await repo("module.exports = { big: () => 'B'.repeat(900 * 1024) };\n");
  try {
    const run = await runHiddenCheck(check, staged.dir, { timeoutMs: 60_000 });
    assert.match(String(run.failure), /more than 8388608 bytes/);
  } finally {
    await staged.cleanup();
  }
});

test('a solution that never answers is a failure at the deadline, not a hang', async () => {
  const check = [
    "const assert = require('node:assert/strict');",
    "const { spin } = require('./lib');",
    'assert.equal(spin(), 1);',
    '',
  ].join('\n');
  const staged = await repo('module.exports = { spin: () => { for (;;) {} } };\n');
  try {
    const started = Date.now();
    const run = await runHiddenCheck(check, staged.dir, { timeoutMs: 500 });
    assert.match(String(run.failure), /did not finish within 500 ms/);
    assert.ok(Date.now() - started < 10_000, 'the deadline did not stop the run');
  } finally {
    await staged.cleanup();
  }
});

test('a solution that floods stdout and stderr changes nothing: the verdict is the check\'s', async () => {
  const check = [
    "const assert = require('node:assert/strict');",
    "const { noisy } = require('./lib');",
    'assert.equal(noisy(), 4);',
    '',
  ].join('\n');
  const staged = await repo([
    "const block = 'C'.repeat(1024 * 1024);",
    'module.exports = {',
    '  noisy() {',
    '    for (let i = 0; i < 4; i++) { process.stdout.write(block); process.stderr.write(block); }',
    '    return 4;',
    '  },',
    '};',
    '',
  ].join('\n'));
  try {
    const run = await runHiddenCheck(check, staged.dir, { timeoutMs: 20_000 });
    assert.equal(run.failure, undefined);
    assert.equal(run.observations.length, 1);
    assert.equal(run.observations[0]?.a, 4);
  } finally {
    await staged.cleanup();
  }
});
