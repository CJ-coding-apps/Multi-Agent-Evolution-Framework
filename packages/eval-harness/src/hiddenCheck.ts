import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toolEnv } from '@maf/types';

/**
 * R7-H2 (D-57): a hidden check never runs in the process that holds the answer.
 *
 * Round 6 ran the check as `node test.js` beside the solution, and the verifier showed why that is
 * not enough: a module that overwrites `require('node:assert')`'s functions passes every check
 * without implementing anything, on pool and train tasks alike. The check's verdict was whatever
 * the solution let it be.
 *
 * Now the check is input/output across a process boundary:
 *
 *  - The checker (this module, in the scoring process) holds the expected values, read from the
 *    encoded store. It never sends them anywhere.
 *  - A driver (`DRIVER_SOURCE`, written into the private scoring directory) runs in a separate
 *    child process, receives the check's source over stdin, loads the solution there, and reports
 *    what the check *observed* — each assertion's actual value, serialized.
 *  - The checker compares the observations with its own expectations. Only a well-formed driver
 *    response counts: a child that exits early, dies, times out, or returns a different number of
 *    observations is a failure.
 *
 * The solution can patch anything in its own process — `node:assert`, `Array.prototype`, its exit
 * code, its stdout — and the verdict does not move: the values it reports are still compared here
 * against values it never saw. The driver captures the primitives it needs before any solution code
 * loads, and writes each observation to a private pipe as it is made.
 *
 * This is a boundary, not a sandbox. A solution that deliberately tampers with the driver's own
 * process (rather than with the check it is meant to help) is the residual D-57 and SECURITY.md
 * state; the 0.7.0 sandbox is where that ends.
 */

/** One serialized JavaScript value, as the driver reports it. */
export type SerializedValue =
  | null
  | boolean
  | string
  | number
  | { t: 'u' | 'h' | 'c' | 'p' | 'f' }
  | { t: 'n'; v: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'i' | 'y' | 'd' | 's'; v: string }
  | { t: 'e'; v: { name: string; message: string } }
  | { t: 'r'; v: { source: string; flags: string } }
  | { t: 'a'; v: SerializedValue[] }
  | { t: 'b'; k: string; v: SerializedValue[] }
  | { t: 'o'; v: Array<[string, SerializedValue]>; c?: string }
  | { t: 'm' | 's'; v: Array<[SerializedValue, SerializedValue]> };

/** The assertion methods the checks use; a hidden check using another is refused, not guessed at. */
const ASSERT_OPS = ['equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'ok', 'throws', 'rejects'] as const;
export type AssertOp = (typeof ASSERT_OPS)[number];
/** The ops the driver may report: the assertions, plus a check's own `process.exit` (never expected). */
const OBSERVED_OPS = [...ASSERT_OPS, 'exit'] as const;

/**
 * One expected observation: what the check's assertion said, recorded at build time from a trusted
 * run (the reference solution, or a proxy module for a train task's visible test). `a` — the value
 * the solution returned — is deliberately absent: it is what a run is judged on, and it must never
 * come from the same place as the expectation.
 */
export interface CheckExpectation {
  op: AssertOp;
  /** `node:assert` (loose) rather than `node:assert/strict`. */
  loose: boolean;
  e?: SerializedValue;
}

/** One observation the driver reported at scoring time; `exit` is a check's own `process.exit`. */
export interface CheckObservation {
  op: AssertOp | 'exit';
  loose: boolean;
  a?: SerializedValue;
  e?: SerializedValue;
  /** `actual === expected`, evaluated in the child: reference identity, where only it decides. */
  same?: boolean;
  threw?: boolean;
  err?: { name: string; message: string };
}

export interface HiddenCheckResult {
  passed: boolean;
  detail: string;
}

const OBSERVATION_TIMEOUT_MS = 120_000;

/** The driver, as source. Written into the private scoring directory and run with `node`. */
export const DRIVER_SOURCE = String.raw`'use strict';
// R7-H2: the hidden-check driver. It runs in its own process and reports observations; it never
// decides pass or fail. Everything it needs is captured before any solution code can run.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const writeSync = fs.writeSync;
const readFileSync = fs.readFileSync;
const stringify = JSON.stringify;
const keysOf = Object.keys;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const objToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const apply = Reflect.apply;
const isNaNNumber = Number.isNaN;
const dateGetTime = Date.prototype.getTime;
const regexSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
const regexFlags = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get;
const mapForEach = Map.prototype.forEach;
const regexTest = RegExp.prototype.test;
const setForEach = Set.prototype.forEach;
const exitProcess = process.exit;
const processOn = process.on;

const cfg = JSON.parse(readFileSync(0, 'utf8'));
const NONCE = cfg.nonce;
const EXIT_SENTINEL = { hiddenCheckExit: true };

function write(record) {
  record.n = NONCE;
  writeSync(3, stringify(record) + '\n');
}

function safeName(fn) {
  try { return typeof fn.name === 'string' ? fn.name : ''; } catch (e) { return ''; }
}

function ctorName(value) {
  try {
    const c = value.constructor;
    return c && typeof c.name === 'string' ? c.name : undefined;
  } catch (e) { return undefined; }
}

function ser(value, seen) {
  const t = typeof value;
  if (t === 'undefined') return { t: 'u' };
  if (value === null) return null;
  if (t === 'boolean' || t === 'string') return value;
  if (t === 'number') {
    if (apply(isNaNNumber, Number, [value])) return { t: 'n', v: 'NaN' };
    if (value === Infinity) return { t: 'n', v: 'Infinity' };
    if (value === -Infinity) return { t: 'n', v: '-Infinity' };
    if (value === 0 && 1 / value === -Infinity) return { t: 'n', v: '-0' };
    return value;
  }
  if (t === 'bigint') return { t: 'i', v: String(value) };
  if (t === 'symbol') return { t: 'y', v: String(value.description) };
  if (t === 'function') return { t: 'f' };
  for (let i = 0; i < seen.length; i++) if (seen[i] === value) return { t: 'c' };
  seen[seen.length] = value;
  try {
    const tag = apply(objToString, value, []);
    if (tag === '[object Date]') return { t: 'd', v: String(apply(dateGetTime, value, [])) };
    if (tag === '[object RegExp]')
      return { t: 'r', v: { source: apply(regexSource, value, []), flags: apply(regexFlags, value, []) } };
    if (tag === '[object Error]' || (apply(hasOwn, value, ['message']) && typeof value.message === 'string' && typeof value.name === 'string'))
      return { t: 'e', v: { name: String(value.name), message: String(value.message) } };
    if (isArray(value)) {
      const n = value.length;
      const out = [];
      for (let i = 0; i < n; i++) out[i] = (i in value) ? ser(value[i], seen) : { t: 'h' };
      return { t: 'a', v: out };
    }
    if (isView(value)) {
      const n = value.length;
      const out = [];
      for (let i = 0; i < n; i++) out[i] = ser(value[i], seen);
      return { t: 'b', k: apply(objToString, value, []).slice(8, -1), v: out };
    }
    if (tag === '[object Map]') {
      const entries = [];
      apply(mapForEach, value, [function (val, key) { entries[entries.length] = [ser(key, seen), ser(val, seen)]; }]);
      return { t: 'm', v: entries };
    }
    if (tag === '[object Set]') {
      const entries = [];
      apply(setForEach, value, [function (val) { entries[entries.length] = [ser(val, seen), null]; }]);
      return { t: 's', v: entries };
    }
    if (tag === '[object Promise]') return { t: 'p' };
    const props = [];
    const ks = keysOf(value);
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      let v;
      try { v = value[k]; } catch (e) { v = undefined; }
      props[props.length] = [k, ser(v, seen)];
    }
    const rec = { t: 'o', v: props };
    const c = ctorName(value);
    if (c !== undefined) rec.c = c;
    return rec;
  } finally {
    seen.length = seen.length - 1;
  }
}

function errorOf(e) {
  try {
    return { name: String(e && e.name !== undefined ? e.name : typeof e), message: String(e && e.message !== undefined ? e.message : e) };
  } catch (err) {
    return { name: 'unknown', message: 'unserializable error' };
  }
}

function makeAssert(loose) {
  const emit = (op, actual, expected, extra) => {
    const record = { op: op, loose: loose, a: ser(actual, []) };
    if (expected !== undefined || op === 'equal' || op === 'notEqual' || op === 'deepEqual' || op === 'notDeepEqual' || op === 'throws' || op === 'rejects')
      record.e = expected === undefined ? { t: 'u' } : ser(expected, []);
    if (extra !== undefined) {
      const ks = keysOf(extra);
      for (let i = 0; i < ks.length; i++) record[ks[i]] = extra[ks[i]];
    }
    write(record);
  };
  const pending = [];
  const a = {
    equal(actual, expected) { emit('equal', actual, expected, { same: actual === expected }); },
    notEqual(actual, expected) { emit('notEqual', actual, expected, { same: actual === expected }); },
    deepEqual(actual, expected) { emit('deepEqual', actual, expected); },
    deepStrictEqual(actual, expected) { emit('deepEqual', actual, expected); },
    notDeepEqual(actual, expected) { emit('notDeepEqual', actual, expected); },
    strictEqual(actual, expected) { emit('equal', actual, expected, { same: actual === expected }); },
    notStrictEqual(actual, expected) { emit('notEqual', actual, expected, { same: actual === expected }); },
    ok(actual) { emit('ok', actual, true); },
    throws(fn, expected) {
      let threw = false;
      let err;
      try { fn(); } catch (e) { threw = true; err = errorOf(e); }
      const record = { op: 'throws', loose: loose, a: null, e: expected === undefined ? { t: 'u' } : ser(expected, []), threw: threw };
      if (threw) record.err = err;
      write(record);
    },
    doesNotThrow(fn, expected) {
      let threw = false;
      let err;
      try { fn(); } catch (e) { threw = true; err = errorOf(e); }
      const record = { op: 'throws', loose: loose, a: null, e: expected === undefined ? { t: 'u' } : ser(expected, []), threw: threw, negate: true };
      if (threw) record.err = err;
      write(record);
    },
    rejects(promise, expected) {
      const settled = (async () => {
        let threw = false;
        let err;
        try { await promise; } catch (e) { threw = true; err = errorOf(e); }
        const record = { op: 'rejects', loose: loose, a: null, e: expected === undefined ? { t: 'u' } : ser(expected, []), threw: threw };
        if (threw) record.err = err;
        write(record);
      })();
      pending[pending.length] = settled;
      return settled;
    },
    match(actual, expected) { emit('ok', typeof actual === 'string' && apply(regexTest, expected, [actual]), true); },
    fail(message) { write({ op: 'ok', loose: loose, a: false, e: true, message: String(message) }); },
  };
  return { assert: a, pending: pending };
}

const looseAssert = makeAssert(true);
const strictAssert = makeAssert(false);

let proxied = null;
function proxify(mod) {
  if (cfg.proxy !== true || mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) return mod;
  if (proxied === null) proxied = new Map();
  if (proxied.has(mod)) return proxied.get(mod);
  const stub = function () { return undefined; };
  const p = new Proxy(mod, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'then' || prop === 'toJSON' || prop === Symbol.iterator) return undefined;
      if (prop in target) return proxify(target[prop]);
      return stub;
    },
    apply() { return undefined; },
    construct() { return {}; },
  });
  proxied.set(mod, p);
  return p;
}

const baseRequire = createRequire(path.join(cfg.repoDir, '__hidden_check__.js'));
function checkRequire(id) {
  if (id === 'node:assert' || id === 'assert') return looseAssert.assert;
  if (id === 'node:assert/strict' || id === 'assert/strict') return strictAssert.assert;
  return proxify(baseRequire(id));
}

const noop = function () {};
const checkModule = { exports: {} };
const checkProcess = {
  env: {}, argv: [], platform: process.platform, version: process.version, pid: process.pid,
  cwd() { return cfg.repoDir; },
  exit(code) {
    const c = typeof code === 'number' ? code : 0;
    write({ op: 'exit', loose: true, a: c, e: 0 });
    throw EXIT_SENTINEL;
  },
  stdout: { write: noop }, stderr: { write: noop },
};
const noopConsole = { log: noop, error: noop, warn: noop, info: noop, debug: noop };
// The check is compiled into *this* realm, not a new one. A fresh vm context gives Date,
// Array.prototype and every built-in a different identity, and a solution's
// value instanceof Date then silently answers false for a date the check just built — the first
// corpus run showed exactly that (train-feature-deep-equal assertion 9). Only the names the
// solution must not choose for itself are shadowed as parameters; everything else is the driver's
// own, captured before any solution code ran.
const CHECK_PARAMS = [
  'source', 'exports', 'require', 'module', '__filename', '__dirname', 'process', 'console',
];
// A direct eval, not a compiled body: the check's completion value is its last expression, and a
// check written as an async IIFE returns that promise (the async corpus tasks end that way, and the
// driver must await them before it can report done). The eval runs in this function's scope, so the
// shadowed names are parameters — the solution cannot reassign them for the check.
const runCheck = vm.compileFunction('return eval(source)', CHECK_PARAMS, { filename: 'hidden-check.js' });

(async function main() {
  let result;
  try {
    result = runCheck(
      cfg.source, checkModule.exports, checkRequire, checkModule,
      path.join(cfg.repoDir, 'hidden-check.js'), cfg.repoDir, checkProcess, noopConsole,
    );
  } catch (e) {
    if (e !== EXIT_SENTINEL) write({ error: errorOf(e) });
  }
  try { await result; } catch (e) {
    if (e !== EXIT_SENTINEL) write({ error: errorOf(e) });
  }
  for (const p of looseAssert.pending.concat(strictAssert.pending)) {
    try { await p; } catch (e) { if (e !== EXIT_SENTINEL) write({ error: errorOf(e) }); }
  }
  write({ op: 'ok', loose: true, a: true, e: true, done: true });
  exitProcess(0);
})();
`;

/** Marker lines the driver writes; anything else on the pipe is ignored or refused. */
interface DriverLine {
  n?: string;
  op?: string;
  loose?: boolean;
  a?: SerializedValue;
  e?: SerializedValue;
  same?: boolean;
  threw?: boolean;
  err?: { name: string; message: string };
  done?: boolean;
  error?: { name: string; message: string };
  message?: string;
  negate?: boolean;
}

/**
 * Runs the check's source against the solution in `repoDir`, in a child process, and returns the
 * observations. A child that does not finish — exited early, killed by the solution, timed out, or
 * wrote an unreadable line — returns an outcome that fails: a check whose driver did not answer has
 * not shown the solution passes.
 */
export async function runHiddenCheck(
  source: string, repoDir: string, opts: { timeoutMs?: number } = {},
): Promise<{ observations: CheckObservation[]; failure?: string }> {
  return await runDriver(source, repoDir, { proxy: false, ...opts });
}

/**
 * Build-time companion: runs the check the same way, but returns the *expectations* the check
 * itself carries. Only the build uses this. `proxy` wraps the fixture's modules so a train task's
 * visible test runs to its last assertion against a starter that would otherwise throw — the
 * expected arguments are literals, and the proxy only absorbs the solution call that precedes them.
 */
export async function captureExpectations(
  source: string, repoDir: string, opts: { proxy?: boolean; timeoutMs?: number } = {},
): Promise<{ expectations: CheckExpectation[]; exitStyle?: boolean; failure?: string }> {
  const run = await runDriver(source, repoDir, { proxy: opts.proxy === true, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  if (run.failure !== undefined) return { expectations: [], failure: run.failure };
  // A check whose verdict is its exit status is recognised from its source as well as from the
  // trusted run: a correct solution (or a proxy) never reaches the `process.exit`, so the run alone
  // cannot tell an exit-status check from one that asserts nothing.
  const exitStyle = run.observations.some((o) => o.op === 'exit') || /\bprocess\s*\.\s*exit\b/.test(source);
  const expectations: CheckExpectation[] = [];
  for (const [i, o] of run.observations.entries()) {
    // A check whose only verdict is its exit status (the seed `coder-*` tasks) records an `exit`
    // observation only when the trusted run fails. Its expectations are empty: a passing run is
    // one that completes without calling process.exit at all.
    if (o.op === 'exit') continue;
    if (o.e === undefined && o.op !== 'ok')
      return { expectations: [], failure: `assertion ${i + 1} (${o.op}) recorded no expected value` };
    const e: CheckExpectation = { op: o.op, loose: o.loose };
    if (o.e !== undefined) e.e = o.e;
    expectations.push(e);
  }
  return { expectations, ...(exitStyle ? { exitStyle: true } : {}) };
}

async function runDriver(
  source: string, repoDir: string, opts: { proxy: boolean; timeoutMs?: number },
): Promise<{ observations: CheckObservation[]; failure?: string }> {
  const nonce = crypto.randomBytes(12).toString('hex');
  const driverPath = path.join(path.dirname(repoDir), 'hidden-check-driver.cjs');
  await writeFile(driverPath, DRIVER_SOURCE, 'utf8');
  const timeoutMs = opts.timeoutMs ?? OBSERVATION_TIMEOUT_MS;
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [driverPath], {
      cwd: repoDir,
      env: toolEnv(),
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
    });
    let buffer = '';
    let observations: CheckObservation[] = [];
    let done = false;
    let malformed: string | undefined;
    let settled = false;
    const finish = (failure?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGKILL');
      if (failure !== undefined) resolve({ observations: [], failure });
      else if (!done) resolve({ observations: [], failure: 'the check driver did not finish' });
      else resolve({ observations, ...(malformed !== undefined ? { failure: malformed } : {}) });
    };
    const timer = setTimeout(() => finish(`the check driver did not finish within ${timeoutMs} ms`), timeoutMs);
    const out = child.stdio[3];
    if (out === null || out === undefined || !('setEncoding' in out)) {
      finish('the check driver has no observation pipe');
      return;
    }
    out.setEncoding('utf8');
    out.on('data', (chunk: string) => {
      if (done) return; // anything after the driver's final line is not the driver's.
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let parsed: DriverLine;
        try { parsed = JSON.parse(line) as DriverLine; } catch { malformed = 'the check driver wrote an unreadable line'; continue; }
        if (parsed.n !== nonce) continue; // a line the driver did not write.
        if (parsed.done === true) { done = true; continue; }
        if (parsed.error !== undefined) {
          malformed = `the check script stopped: ${parsed.error.name}: ${parsed.error.message}`;
          continue;
        }
        if (typeof parsed.op !== 'string' || !(OBSERVED_OPS as readonly string[]).includes(parsed.op)) continue;
        const obs: CheckObservation = { op: parsed.op as AssertOp | 'exit', loose: parsed.loose !== false };
        if (parsed.a !== undefined) obs.a = parsed.a;
        if (parsed.e !== undefined) obs.e = parsed.e;
        if (parsed.same !== undefined) obs.same = parsed.same;
        if (parsed.threw !== undefined) obs.threw = parsed.threw;
        if (parsed.err !== undefined) obs.err = parsed.err;
        observations = [...observations, obs];
      }
    });
    child.on('error', (err) => finish(`the check driver could not start: ${err.message}`));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (malformed !== undefined) finish(malformed);
      else if (!done) finish(`the check driver exited (${signal ?? code}) before it finished`);
      else finish();
    });
    if (child.stdin === null) {
      finish('the check driver has no input pipe');
      return;
    }
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({
      source, repoDir, nonce,
      proxy: opts.proxy,
    }));
  });
}

/**
 * A serialized primitive as the JavaScript value it stands for, or `undefined` when the value is
 * an object (including functions and symbols, which only reference identity can compare).
 */
function primitiveOf(v: SerializedValue | undefined): { ok: boolean; value?: unknown } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number')
    return { ok: true, value: v };
  if (typeof v === 'object') {
    if (v.t === 'u') return { ok: true, value: undefined };
    if (v.t === 'n') {
      const m: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
      return { ok: true, value: m[v.v] };
    }
  }
  return { ok: false };
}

/** JavaScript `==` for two primitives, so a loose assertion keeps its own semantics. */
function loosePrimitiveEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'boolean') return loosePrimitiveEqual(Number(a), b);
  if (typeof b === 'boolean') return loosePrimitiveEqual(a, Number(b));
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  return a === b;
}

/** `Object.is` for strict primitives, `==` for loose ones: the assertion's own comparison. */
function leafEqual(a: SerializedValue | undefined, b: SerializedValue | undefined, loose: boolean): boolean {
  const pa = primitiveOf(a);
  const pb = primitiveOf(b);
  if (!pa.ok || !pb.ok) return false;
  if (loose) return loosePrimitiveEqual(pa.value, pb.value);
  if (typeof pa.value === 'number' && typeof pb.value === 'number') return Object.is(pa.value, pb.value);
  return pa.value === pb.value;
}

/**
 * `assert.equal` / `assert.notEqual`: primitives by value, everything else by reference — and
 * reference identity was decided in the child (`same`), where both objects still exist.
 */
function shallowEqual(actual: SerializedValue | undefined, expected: SerializedValue | undefined, loose: boolean, same?: boolean): boolean {
  const pa = primitiveOf(actual);
  const pe = primitiveOf(expected);
  if (pa.ok && pe.ok) {
    if (loose) return loosePrimitiveEqual(pa.value, pe.value);
    if (typeof pa.value === 'number' && typeof pe.value === 'number') return Object.is(pa.value, pe.value);
    return pa.value === pe.value;
  }
  return same === true;
}

function deepSerializedEqual(a: SerializedValue, e: SerializedValue, loose: boolean): boolean {
  if (a === null || e === null) return a === e;
  if (typeof a !== 'object' || typeof e !== 'object') return leafEqual(a, e, loose);
  const at = (a as { t: string }).t;
  const et = (e as { t: string }).t;
  if (at !== et) return false;
  const ao = a as Record<string, unknown>;
  const eo = e as Record<string, unknown>;
  switch (at) {
    case 'u': case 'h': case 'c': case 'p': case 'f':
      return true;
    case 'n': case 'd': case 'i': case 'y':
      return ao['v'] === eo['v'];
    case 'e': {
      const av = ao['v'] as { name: string; message: string };
      const ev = eo['v'] as { name: string; message: string };
      return av.name === ev.name && av.message === ev.message;
    }
    case 'r': {
      const av = ao['v'] as { source: string; flags: string };
      const ev = eo['v'] as { source: string; flags: string };
      return av.source === ev.source && av.flags === ev.flags;
    }
    case 'b': {
      if (ao['k'] !== eo['k']) return false;
      const av = ao['v'] as SerializedValue[];
      const ev = eo['v'] as SerializedValue[];
      return av.length === ev.length && av.every((v, i) => deepSerializedEqual(v, ev[i] as SerializedValue, loose));
    }
    case 'a': {
      const av = ao['v'] as SerializedValue[];
      const ev = eo['v'] as SerializedValue[];
      return av.length === ev.length && av.every((v, i) => deepSerializedEqual(v, ev[i] as SerializedValue, loose));
    }
    case 'o': {
      // `deepStrictEqual` also compares prototypes; `deepEqual` does not.
      if (!loose && (ao['c'] ?? undefined) !== (eo['c'] ?? undefined)) return false;
      const av = ao['v'] as Array<[string, SerializedValue]>;
      const ev = eo['v'] as Array<[string, SerializedValue]>;
      if (av.length !== ev.length) return false;
      const em = new Map(ev);
      for (const [k, v] of av) {
        if (!em.has(k)) return false;
        if (!deepSerializedEqual(v, em.get(k) as SerializedValue, loose)) return false;
      }
      return true;
    }
    case 'm': case 's': {
      const av = ao['v'] as Array<[SerializedValue, SerializedValue]>;
      const ev = eo['v'] as Array<[SerializedValue, SerializedValue]>;
      return av.length === ev.length && av.every((pair, i) => {
        const other = ev[i] as [SerializedValue, SerializedValue];
        return deepSerializedEqual(pair[0], other[0], loose) && deepSerializedEqual(pair[1], other[1], loose);
      });
    }
    default:
      return false;
  }
}

function truthy(v: SerializedValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  return true;
}

/** Applies every assertion's own predicate. The first disagreement is the detail. */
export function compareObservations(
  observations: readonly CheckObservation[], expectations: readonly CheckExpectation[],
): HiddenCheckResult {
  if (expectations.length === 0) {
    if (observations.length === 0) return { passed: true, detail: 'the check completed without exiting' };
    return { passed: false, detail: `the check exited or asserted: ${describe(observations[0]?.a)}` };
  }
  if (observations.length !== expectations.length)
    return {
      passed: false,
      detail: `the check made ${observations.length} assertion${observations.length === 1 ? '' : 's'}; ` +
        `it must make ${expectations.length}`,
    };
  for (let i = 0; i < expectations.length; i++) {
    const o = observations[i] as CheckObservation;
    const e = expectations[i] as CheckExpectation;
    if (o.op !== e.op)
      return { passed: false, detail: `assertion ${i + 1}: the check reported ${o.op}, expected ${e.op}` };
    if (o.op === 'throws' || o.op === 'rejects') {
      if (o.threw !== true) return { passed: false, detail: `assertion ${i + 1}: expected a throw, none was raised` };
      const expected = e.e;
      if (expected !== undefined && expected !== null && typeof expected === 'object' && (expected as { t?: string }).t === 'r') {
        const { source, flags } = (expected as { v: { source: string; flags: string } }).v;
        const re = new RegExp(source, flags);
        const message = o.err?.message ?? '';
        if (!re.test(message) && !new RegExp(source, flags).test(String(o.err?.name ?? '')))
          return { passed: false, detail: `assertion ${i + 1}: ${JSON.stringify(message)} does not match ${re}` };
      } else if (expected !== undefined && expected !== null && typeof expected === 'object' && (expected as { t?: string }).t === 'f') {
        // a constructor argument was given but its name was not recorded; a throw is the contract.
      }
      continue;
    }
    if (o.op === 'ok') {
      const actual = truthy(o.a);
      if (!actual) return { passed: false, detail: `assertion ${i + 1}: ok() got a falsy value ${describe(o.a)}` };
      continue;
    }
    const equal = o.op === 'deepEqual' || o.op === 'notDeepEqual'
      ? deepSerializedEqual(o.a === undefined ? { t: 'u' } : o.a, e.e === undefined ? { t: 'u' } : e.e, e.loose)
      : shallowEqual(o.a, e.e, e.loose, o.same);
    const want = o.op === 'notEqual' || o.op === 'notDeepEqual' ? false : true;
    if (equal !== want)
      return {
        passed: false,
        detail: `assertion ${i + 1}: ${o.op} saw ${describe(o.a)}, expected ${describe(e.e)}`,
      };
  }
  return { passed: true, detail: `the check made ${observations.length} assertion${observations.length === 1 ? '' : 's'}` };
}

function describe(v: SerializedValue | undefined): string {
  if (v === undefined) return 'undefined';
  const text = JSON.stringify(v);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
