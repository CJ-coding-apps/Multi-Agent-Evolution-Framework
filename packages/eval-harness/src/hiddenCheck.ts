import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { toolEnv } from '@maf/types';

/**
 * R7-H1 (D-57): the child that holds the solution never receives the check.
 *
 * R7-H2 moved the check's *verdict* out of the solution's process, but it still sent the check's
 * source — expected literals and canary included — to the child that loaded the solution. The
 * verifier showed what that costs: a solution that implemented nothing read the source through
 * `fn.caller.arguments[0]`, replayed every expected literal, and passed. A boundary that hands the
 * answer to the side under test is not a boundary.
 *
 * The protocol is now descriptions in, values out:
 *
 *  - The **check runs in the checker** (this module, in the scoring process). Its source, its
 *    expected values and its canary never leave this process. The check's `require` and every
 *    function it calls on the solution are proxies over a call-description protocol.
 *  - A **driver** (`DRIVER_SOURCE`) runs in a separate child process, started with
 *    `--disallow-code-generation-from-strings` and in strict mode. It receives only *call
 *    descriptions* — a module specifier to require, a function to call, the input arguments, a
 *    property to read — and the values the solution returns. It never receives code, and never
 *    evaluates any.
 *  - Messages are signed with a key the driver reads from its stdin before any solution code can
 *    load, written through append-only logs in a private session directory. A solution that finds
 *    the directory can neither forge a reply nor a callback, and anything it does write is either
 *    rejected or fails the run closed.
 *
 * Values cross as data. Plain objects, arrays, maps, sets, dates, typed arrays and errors are
 * materialised on the far side and updated in place, so `assert.deepEqual` sees real values and a
 * mutation the solution makes to an argument is visible to the check afterwards. Functions become
 * call proxies in both directions; class instances keep their methods. A call that returns a
 * thenable answers `pending` immediately and settles when the promise does, so an async check can
 * await a solution without deadlocking the checker's synchronous stack.
 *
 * The check still only *records* its assertions; the comparison is `compareObservations` in the
 * checker, against values that never crossed. This is a boundary, not a sandbox: a solution that
 * attacks the operating system rather than the check is the residual D-57 names, and the 0.7.0
 * sandbox is where that ends.
 */

/** One serialized JavaScript value, as the check's assertion reports it. */
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
  /** R9-L4: the name of the constructor `throws`/`rejects` was given, e.g. `TypeError`. */
  errType?: string;
}

/** One observation the check reported while it ran in the checker; `exit` is its own `process.exit`. */
export interface CheckObservation {
  op: AssertOp | 'exit';
  loose: boolean;
  a?: SerializedValue;
  e?: SerializedValue;
  /** `actual === expected`, evaluated where both values live: the checker, now. */
  same?: boolean;
  threw?: boolean;
  err?: { name: string; message: string };
  /** R9-L4: `doesNotThrow` records a `throws` observation with this set; its verdict is inverted. */
  negate?: boolean;
  /** R9-L4: the constructor named as `throws`'s second argument, if it was a function. */
  errType?: string;
}

export interface HiddenCheckResult {
  passed: boolean;
  detail: string;
}

const OBSERVATION_TIMEOUT_MS = 120_000;
/** R8-L1: caps on what the checker will read from the child. Over either one is a failure. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PUMP_SLEEP_MS = 1;

/**
 * The driver, as source. It runs in its own process, holds the solution, and receives call
 * descriptions only. Written into the private session directory and started with
 * `--disallow-code-generation-from-strings`.
 */
export const DRIVER_SOURCE = String.raw`'use strict';
// R7-H1 (D-57): the hidden-check driver. It holds the solution and executes call descriptions. It
// never receives the check's source, its expected values or its canary, and it evaluates no code
// that crosses the boundary. Everything it needs is captured before any solution code can run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const readFileSync = fs.readFileSync;
const openSync = fs.openSync;
const readSync = fs.readSync;
const writeSync = fs.writeSync;
const closeSync = fs.closeSync;
const statSync = fs.statSync;
const exitProcess = process.exit;
const processOn = process.on.bind(process);
const stringify = JSON.stringify;
const parse = JSON.parse;
const createHmac = crypto.createHmac;
const timingSafeEqual = crypto.timingSafeEqual;
const BufferFrom = Buffer.from;
const BufferIsBuffer = Buffer.isBuffer;
const BufferCtor = Buffer;
const AtomicsObject = Atomics;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const dateNow = Date.now;
const keysOf = Object.keys;
const ownNames = Object.getOwnPropertyNames;
const getOwnDesc = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const createObject = Object.create;
const getProto = Object.getPrototypeOf;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const objToString = Object.prototype.toString;
const apply = Reflect.apply;
const construct = Reflect.construct;
const dateGetTime = Date.prototype.getTime;
const regexSource = getOwnDesc(RegExp.prototype, 'source').get;
const regexFlags = getOwnDesc(RegExp.prototype, 'flags').get;
const mapForEach = Map.prototype.forEach;
const mapSet = Map.prototype.set;
const mapClear = Map.prototype.clear;
const setForEach = Set.prototype.forEach;
const setAdd = Set.prototype.add;
const setClear = Set.prototype.clear;
const promiseThen = Promise.prototype.then;
const PromiseResolve = Promise.resolve;
const MapCtor = Map;
const SetCtor = Set;
const DateCtor = Date;
const RegExpCtor = RegExp;
const ErrorCtor = Error;
const NumberFn = Number;
const StringFn = String;
const BigIntFn = BigInt;
const SymbolFn = Symbol;
const theSetInterval = setInterval;

const MAX_LINE = 1048576;
const MAX_TOTAL = 8388608;
const LIFE_MS = 600000;

const cfg = parse(readFileSync(0, 'utf8'));
const KEY = cfg.key;
const DIR = cfg.dir;
const ROOT = cfg.repoDir;
const IN = path.join(DIR, 'to-child.log');
const OUT = path.join(DIR, 'to-checker.log');
const startedAt = dateNow();

const outFd = openSync(OUT, 'a');
const inFd = openSync(IN, 'r');
let offset = 0;
let acc = Buffer.alloc(0);
let received = 0;
let stopping = false;
const rets = new Map();
const pendings = new Map();
const settledEarly = new Map();
const objs = new Map();
const objIds = new WeakMap();
const fns = new Map();
const fnIds = new WeakMap();
const cbIds = new WeakMap();
let seq = 0;
let pidSeq = 0;

const NUMBERS = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
const VIEWS = {
  Int8Array: Int8Array, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray,
  Int16Array: Int16Array, Uint16Array: Uint16Array, Int32Array: Int32Array, Uint32Array: Uint32Array,
  Float32Array: Float32Array, Float64Array: Float64Array, BigInt64Array: BigInt64Array,
  BigUint64Array: BigUint64Array,
};

function errorOf(e) {
  try {
    return { name: StringFn(e && e.name !== undefined ? e.name : typeof e), message: StringFn(e && e.message !== undefined ? e.message : e) };
  } catch (err) {
    return { name: 'unknown', message: 'unserializable error' };
  }
}

function rethrow(record) {
  const e = new ErrorCtor(record && record.message !== undefined ? record.message : 'the check raised an error');
  if (record && record.name !== undefined) e.name = StringFn(record.name);
  return e;
}

function sign(text) {
  const h = apply(createHmac, crypto, ['sha256', KEY]);
  h.update(text);
  return h.digest('hex');
}

function send(msg) {
  let text;
  try { text = stringify(msg); } catch (e) {
    text = stringify({ k: 'bye', message: 'a value could not be serialized' });
  }
  writeSync(outFd, sign(text) + ' ' + text + '\n');
}

function fatal(message) {
  try { send({ k: 'bye', message: message }); } catch (e) { /* the outbox may be unreadable */ }
  stopping = true;
  exitProcess(2);
}

/* ---------- wire: values as data, never code ---------- */

function wire(value, seen) {
  const t = typeof value;
  if (t === 'undefined') return { t: 'u' };
  if (value === null) return null;
  if (t === 'boolean' || t === 'string') return value;
  if (t === 'number') {
    if (value !== value) return { t: 'n', v: 'NaN' };
    if (value === Infinity) return { t: 'n', v: 'Infinity' };
    if (value === -Infinity) return { t: 'n', v: '-Infinity' };
    if (value === 0 && 1 / value === -Infinity) return { t: 'n', v: '-0' };
    return value;
  }
  if (t === 'bigint') return { t: 'i', v: StringFn(value) };
  if (t === 'symbol') return { t: 'y', d: StringFn(value.description) };
  if (t === 'function') {
    let fid = cbIds.get(value);
    if (fid === undefined) fid = fnIds.get(value);
    if (fid === undefined) {
      fid = 'sf' + (seq++);
      fnIds.set(value, fid);
      fns.set(fid, value);
    }
    return { t: 'F', id: fid };
  }
  if (seen === undefined) seen = new Map();
  const earlier = seen.get(value);
  if (earlier !== undefined) return { t: 'X', id: earlier };
  let id = objIds.get(value);
  if (id === undefined) { id = 's' + (seq++); objIds.set(value, id); }
  objs.set(id, value);
  seen.set(value, id);
  const tag = apply(objToString, value, []);
  if (tag === '[object Date]') return { t: 'D', v: StringFn(apply(dateGetTime, value, [])) };
  if (tag === '[object RegExp]') return { t: 'R', s: apply(regexSource, value, []), f: apply(regexFlags, value, []) };
  if (tag === '[object Error]') return { t: 'E', n: StringFn(value.name), m: StringFn(value.message) };
  if (tag === '[object Promise]') return { t: 'P' };
  if (isArray(value)) {
    const n = value.length;
    const out = [];
    for (let i = 0; i < n; i++) out[i] = (i in value) ? wire(value[i], seen) : { t: 'H' };
    return { t: 'A', id: id, v: out };
  }
  if (isView(value)) {
    const n = value.length;
    const out = [];
    for (let i = 0; i < n; i++) out[i] = wire(value[i], seen);
    if (apply(BufferIsBuffer, BufferCtor, [value])) return { t: 'V', id: id, k: 'Buffer', b: apply(value.toString, value, ['base64']) };
    return { t: 'V', id: id, k: tag.slice(8, -1), v: out };
  }
  if (tag === '[object Map]') {
    const entries = [];
    apply(mapForEach, value, [function (val, key) { entries[entries.length] = [wire(key, seen), wire(val, seen)]; }]);
    return { t: 'M', id: id, v: entries };
  }
  if (tag === '[object Set]') {
    const entries = [];
    apply(setForEach, value, [function (val) { entries[entries.length] = wire(val, seen); }]);
    return { t: 'S', id: id, v: entries };
  }
  const props = [];
  const ks = keysOf(value);
  for (let i = 0; i < ks.length; i++) props[i] = [ks[i], wire(value[ks[i]], seen)];
  const methods = [];
  const ownProto = getProto(value);
  let proto = ownProto;
  let depth = 0;
  while (proto !== null && proto !== Object.prototype && depth < 8) {
    const names = ownNames(proto);
    for (let i = 0; i < names.length; i++) {
      const k = names[i];
      if (k === 'constructor' || k === '__proto__') continue;
      const d = getOwnDesc(proto, k);
      if (d === undefined) continue;
      if (typeof d.value === 'function') methods[methods.length] = [k, wire(d.value, seen)];
      else if (d.get !== undefined || d.set !== undefined) methods[methods.length] = [k, { t: 'G' }];
    }
    proto = getProto(proto);
    depth++;
  }
  const rec = { t: 'O', id: id, p: props };
  if (methods.length > 0) rec.m = methods;
  if (ownProto === null) rec.np = true;
  else if (typeof ownProto.constructor === 'function' && typeof ownProto.constructor.name === 'string')
    rec.cn = ownProto.constructor.name;
  return rec;
}

function unreadable() { return undefined; }

function named(name) {
  const holder = {};
  holder[name] = function () { return undefined; };
  return holder[name];
}

function fromWire(w) {
  if (w === null || typeof w !== 'object') return w;
  const t = w.t;
  if (t === 'u') return undefined;
  if (t === 'n') return NUMBERS[w.v];
  if (t === 'i') return BigIntFn(w.v);
  if (t === 'y') return SymbolFn(w.d);
  if (t === 'D') return new DateCtor(NumberFn(w.v));
  if (t === 'R') return new RegExpCtor(w.s, w.f);
  if (t === 'E') return rethrow({ name: w.n, message: w.m });
  if (t === 'P') return apply(PromiseResolve, Promise, [undefined]);
  if (t === 'F') return fnFor(w.id);
  if (t === 'X') return objs.get(w.id);
  if (t === 'H') return undefined;
  const id = w.id;
  if (typeof id === 'string' && id.charCodeAt(0) !== 99) {
    const live = objs.get(id);
    if (live !== undefined) return live;
  }
  if (t === 'A') {
    let a = objs.get(id);
    if (a === undefined) { a = []; objs.set(id, a); objIds.set(a, id); }
    const vals = w.v;
    a.length = vals.length;
    for (let i = 0; i < vals.length; i++) {
      const item = vals[i];
      if (item !== null && typeof item === 'object' && item.t === 'H') delete a[i];
      else a[i] = fromWire(item);
    }
    return a;
  }
  if (t === 'V') {
    if (w.k === 'Buffer') {
      let b = objs.get(id);
      if (b === undefined) { b = apply(BufferFrom, BufferCtor, [w.b, 'base64']); objs.set(id, b); objIds.set(b, id); }
      return b;
    }
    const Ctor = VIEWS[w.k];
    if (Ctor === undefined) return {};
    let v = objs.get(id);
    if (v === undefined) { v = new Ctor(w.v.length); objs.set(id, v); objIds.set(v, id); }
    for (let i = 0; i < w.v.length; i++) v[i] = fromWire(w.v[i]);
    return v;
  }
  if (t === 'M') {
    let m = objs.get(id);
    if (m === undefined) { m = new MapCtor(); objs.set(id, m); objIds.set(m, id); }
    apply(mapClear, m, []);
    for (let i = 0; i < w.v.length; i++) apply(mapSet, m, [fromWire(w.v[i][0]), fromWire(w.v[i][1])]);
    return m;
  }
  if (t === 'S') {
    let s = objs.get(id);
    if (s === undefined) { s = new SetCtor(); objs.set(id, s); objIds.set(s, id); }
    apply(setClear, s, []);
    for (let i = 0; i < w.v.length; i++) apply(setAdd, s, [fromWire(w.v[i])]);
    return s;
  }
  let o = objs.get(id);
  if (o === undefined) { o = w.np === true ? createObject(null) : {}; objs.set(id, o); objIds.set(o, id); }
  const props = w.p;
  const keep = [];
  for (let i = 0; i < props.length; i++) keep[i] = props[i][0];
  const current = keysOf(o);
  for (let i = 0; i < current.length; i++) {
    let found = false;
    for (let j = 0; j < keep.length; j++) if (keep[j] === current[i]) { found = true; break; }
    if (!found) delete o[current[i]];
  }
  for (let i = 0; i < props.length; i++) o[props[i][0]] = fromWire(props[i][1]);
  const methods = w.m;
  if (methods !== undefined) {
    for (let i = 0; i < methods.length; i++) {
      const k = methods[i][0];
      const def = methods[i][1];
      if (def !== null && typeof def === 'object' && def.t === 'G') {
        if (!(k in o)) defineProperty(o, k, { get: unreadable, enumerable: false, configurable: true });
      } else if (!(k in o)) {
        defineProperty(o, k, { value: fnFor(def.id), enumerable: false, configurable: true, writable: true });
      }
    }
  }
  if (typeof w.cn === 'string' && !('constructor' in o)) {
    // The mirror must answer value.constructor.name the way the real instance did, so a strict
    // deep comparison sees the same class name on both sides.
    defineProperty(o, 'constructor', { value: named(w.cn), enumerable: false, configurable: true });
  }
  return o;
}

function argsFrom(list) {
  const out = [];
  if (list === undefined || list === null) return out;
  for (let i = 0; i < list.length; i++) out[i] = fromWire(list[i]);
  return out;
}

function wireArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) out[i] = wire(args[i]);
  return out;
}

function liveId(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  return objIds.get(value);
}

function statesFor(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const live = objs.get(ids[i]);
    if (live !== undefined && (typeof live === 'object' || typeof live === 'function')) out[out.length] = wire(live);
  }
  return out;
}

/* ---------- calling back into the checker ---------- */

function fnFor(id) {
  const known = fns.get(id);
  if (known !== undefined) return known;
  if (typeof id === 'string' && id.charCodeAt(0) === 115) {
    // An id the child minted but no longer holds: a stub keeps the call legal instead of crashing
    // the driver on a value the checker kept a reference to.
    return function () { return undefined; };
  }
  const f = function () {
    const callId = 'c' + (seq++);
    send({ k: 'call', id: callId, fid: id, self: wire(this), args: wireArgs(arguments) });
    const ret = waitFor(callId);
    // An asynchronous check callback: the checker answers "pending", and the call becomes a promise
    // here, which the solution may await. The checker's own stack is free once the outer call is
    // pending, so its continuation can run and send the settlement.
    if (ret.pending === true) return awaiting(ret.pid);
    if (ret.ok !== true) throw rethrow(ret.error);
    return fromWire(ret.value);
  };
  cbIds.set(f, id);
  fns.set(id, f);
  return f;
}

function awaiting(pid) {
  // A settlement can arrive in the same read as the "pending" answer that named it, before this
  // promise exists; it is held rather than dropped, or the call would never settle.
  const early = settledEarly.get(pid);
  if (early !== undefined) {
    settledEarly.delete(pid);
    return early.ok === true
      ? Promise.resolve(fromWire(early.value))
      : Promise.reject(rethrow(early.error));
  }
  return new Promise(function (resolve, reject) { pendings.set(pid, { resolve: resolve, reject: reject }); });
}

/* ---------- requests from the checker ---------- */

const baseRequire = createRequire(path.join(ROOT, '__hidden_check__.js'));

function handleCall(msg) {
  const id = msg.id;
  let fn;
  let self;
  let args;
  try {
    fn = fns.get(msg.fid);
    if (typeof fn !== 'function') throw new ErrorCtor('no such function: ' + StringFn(msg.fid));
    self = msg.ctor === true ? undefined : fromWire(msg.self);
    args = argsFrom(msg.args);
  } catch (e) {
    send({ k: 'ret', id: id, ok: false, error: errorOf(e) });
    return;
  }
  const touched = [];
  const selfId = liveId(self);
  if (selfId !== undefined) touched[touched.length] = selfId;
  if (msg.args !== undefined) for (let i = 0; i < msg.args.length; i++) {
    const argId = liveId(args[i]);
    if (argId !== undefined) touched[touched.length] = argId;
  }
  let r;
  try {
    r = msg.ctor === true ? construct(fn, args) : apply(fn, self, args);
  } catch (e) {
    send({ k: 'ret', id: id, ok: false, error: errorOf(e), states: statesFor(touched) });
    return;
  }
  if (r !== null && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') {
    const pid = 'p' + (pidSeq++);
    send({ k: 'ret', id: id, pending: true, pid: pid, states: statesFor(touched) });
    const onOk = function (value) { send({ k: 'settled', pid: pid, ok: true, value: wire(value) }); };
    const onErr = function (e) { send({ k: 'settled', pid: pid, ok: false, error: errorOf(e) }); };
    apply(promiseThen, apply(PromiseResolve, Promise, [r]), [onOk, onErr]);
    return;
  }
  let value;
  try { value = wire(r); } catch (e) {
    send({ k: 'ret', id: id, ok: false, error: errorOf(e) });
    return;
  }
  send({ k: 'ret', id: id, ok: true, value: value, states: statesFor(touched) });
}

function handleGet(msg) {
  let value;
  try { value = objs.get(msg.target)[msg.key]; } catch (e) {
    send({ k: 'ret', id: msg.id, ok: false, error: errorOf(e) });
    return;
  }
  let wired;
  try { wired = wire(value); } catch (e) {
    send({ k: 'ret', id: msg.id, ok: false, error: errorOf(e) });
    return;
  }
  send({ k: 'ret', id: msg.id, ok: true, value: wired });
}

function handleRequire(msg) {
  let loaded;
  try { loaded = baseRequire(msg.spec); } catch (e) {
    send({ k: 'ret', id: msg.id, ok: false, error: errorOf(e) });
    return;
  }
  let value;
  try { value = wire(loaded); } catch (e) {
    send({ k: 'ret', id: msg.id, ok: false, error: errorOf(e) });
    return;
  }
  send({ k: 'ret', id: msg.id, ok: true, value: value });
}

function dispatch(msg) {
  if (msg.k === 'call') { handleCall(msg); return; }
  if (msg.k === 'get') { handleGet(msg); return; }
  if (msg.k === 'require') { handleRequire(msg); return; }
  if (msg.k === 'settled') {
    const waiter = pendings.get(msg.pid);
    if (waiter !== undefined) {
      pendings.delete(msg.pid);
      if (msg.ok === true) waiter.resolve(fromWire(msg.value));
      else waiter.reject(rethrow(msg.error));
    } else {
      settledEarly.set(msg.pid, msg);
    }
    return;
  }
  if (msg.k === 'ret') { rets.set(msg.id, msg); return; }
  if (msg.k === 'done') { stopping = true; try { closeSync(outFd); } catch (e) { /* already closed */ } exitProcess(0); }
}

/* ---------- the signed inbox ---------- */

function handleLine(line) {
  const sp = line.indexOf(' ');
  if (sp < 0) return;
  const sig = line.slice(0, sp);
  const text = line.slice(sp + 1);
  const want = sign(text);
  if (sig.length !== want.length) return;
  if (!apply(timingSafeEqual, crypto, [Buffer.from(sig, 'utf8'), Buffer.from(want, 'utf8')])) return;
  let msg;
  try { msg = parse(text); } catch (e) { return; }
  dispatch(msg);
}

function readNew() {
  if (stopping) return;
  let size;
  try { size = statSync(IN).size; } catch (e) { return; }
  if (size <= offset) return;
  const len = size - offset;
  const chunk = Buffer.allocUnsafe(len);
  const n = readSync(inFd, chunk, 0, len, offset);
  if (n <= 0) return;
  offset += n;
  received += n;
  if (received > MAX_TOTAL) { fatal('the check driver read more than ' + MAX_TOTAL + ' bytes'); return; }
  acc = Buffer.concat([acc, chunk.subarray(0, n)]);
  for (;;) {
    const nl = acc.indexOf(10);
    if (nl < 0) break;
    if (nl > MAX_LINE) { fatal('the check driver read an oversized message'); return; }
    const line = acc.subarray(0, nl).toString('utf8');
    acc = acc.subarray(nl + 1);
    handleLine(line);
    if (stopping) return;
  }
  if (acc.length > MAX_LINE) fatal('the check driver read an oversized message');
}

function waitFor(id) {
  for (;;) {
    readNew();
    const got = rets.get(id);
    if (got !== undefined) { rets.delete(id); return got; }
    if (stopping) throw new ErrorCtor('the check driver stopped');
    if (dateNow() - startedAt > LIFE_MS) fatal('the check driver outlived its checker');
    apply(AtomicsObject.wait, AtomicsObject, [sleepCell, 0, 0, 1]);
  }
}

function pollOnce() {
  try { readNew(); } catch (e) { fatal('the check driver could not read its inbox'); }
}

processOn('exit', function () {
  try { send({ k: 'bye' }); } catch (e) { /* the reader is gone */ }
});
processOn('uncaughtException', function (e) {
  try { send({ k: 'bye', message: 'uncaught: ' + errorOf(e).message }); } catch (err) { /* the reader is gone */ }
  exitProcess(4);
});

theSetInterval(pollOnce, 1);
send({ k: 'ret', id: 'ready', ok: true });
`;

/* ---------- the checker side: values, ids and the signed protocol ---------- */

/** A value on the wire. Primitives are themselves; everything else is a tagged record. */
type WireValue = null | boolean | number | string | Record<string, unknown>;

interface RetMessage {
  [key: string]: unknown;
  id: string;
  ok?: boolean;
  value?: WireValue;
  error?: { name?: string; message?: string };
  pending?: boolean;
  pid?: string;
  states?: WireValue[];
}

interface SettledMessage {
  [key: string]: unknown;
  pid: string;
  ok?: boolean;
  value?: WireValue;
  error?: { name?: string; message?: string };
}

const NUMBERS: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
const VIEW_CTORS: Record<string, new (n: number) => unknown> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array,
};

class BoundaryFailure extends Error {}

/**
 * One scoring session: a child that holds the solution, a signed pair of append-only logs, and the
 * mirrors of every value that has crossed. Values keep their identity by id, so a mutation the
 * solution makes is applied to the very object the check holds.
 */
class CheckerBridge {
  failure?: string;
  readonly childPid: number | undefined;

  private readonly key: string;
  private readonly dir: string;
  private readonly timeoutMs: number;
  private readonly child: ChildProcess;
  private readonly inFd: number;
  private readonly outFd: number;
  private readonly sleepCell = new Int32Array(new SharedArrayBuffer(4));
  private readonly deadline: number;
  private readonly poller: NodeJS.Timeout;
  private readonly failWaiters: Array<(failure: string) => void> = [];
  private readonly rets = new Map<string, RetMessage>();
  private readonly objects = new Map<string, unknown>();
  private readonly objIds = new WeakMap<object, string>();
  private readonly fnProxies = new Map<string, (...args: unknown[]) => unknown>();
  private readonly fnIds = new WeakMap<object, string>();
  private readonly childFidByProxy = new WeakMap<object, string>();
  private readonly callbacks = new Map<string, (...args: unknown[]) => unknown>();
  private readonly settledWaiters = new Map<string, (message: SettledMessage) => void>();
  private readonly settledEarly = new Map<string, SettledMessage>();

  private offset = 0;
  private acc: Buffer = Buffer.alloc(0);
  private total = 0;
  private seq = 0;
  private fnSeq = 0;
  private closed = false;

  constructor(opts: { child: ChildProcess; dir: string; key: string; timeoutMs: number }) {
    this.child = opts.child;
    this.dir = opts.dir;
    this.key = opts.key;
    this.timeoutMs = opts.timeoutMs;
    this.childPid = opts.child.pid;
    this.inFd = openSync(path.join(opts.dir, 'to-checker.log'), 'r');
    this.outFd = openSync(path.join(opts.dir, 'to-child.log'), 'a');
    this.deadline = Date.now() + opts.timeoutMs;
    this.poller = setInterval(() => this.poll(), PUMP_SLEEP_MS);
    this.poller.unref?.();
    this.child.on('error', (err) => this.fail(`the check driver could not start: ${err.message}`));
  }

  /** True once the driver has said it is up, before any solution code exists. */
  get ready(): boolean { return this.rets.has('ready'); }

  /** The child's own pid, so a check that reports `process.pid` reports the process the solution
   *  is in, and the checker's own pid never appears. */
  get pid(): number | undefined { return this.childPid; }

  /** The check calls a function the solution owns. Blocks while the solution runs, unless the
   *  solution answered with a promise; then the call is a promise the check may await. */
  invoke(fid: string, thisArg: unknown, args: unknown[], ctor: boolean): unknown {
    const id = `r${this.seq++}`;
    const message: Record<string, unknown> = { k: 'call', id, fid, args: args.map((a) => this.toWire(a)) };
    if (ctor) message['ctor'] = true;
    else message['self'] = this.toWire(thisArg);
    this.send(message);
    const ret = this.pump(id);
    this.applyStates(ret);
    if (ret.pending === true) return this.promiseFor(String(ret.pid));
    if (ret.ok !== true) throw this.rethrow(ret.error);
    return this.fromWire(ret.value);
  }

  /** A getter on a class the solution owns: reading it runs the solution's code, there. */
  readProperty(id: string, key: string): unknown {
    const requestId = `r${this.seq++}`;
    this.send({ k: 'get', id: requestId, target: id, key });
    const ret = this.pump(requestId);
    if (ret.ok !== true) throw this.rethrow(ret.error);
    return this.fromWire(ret.value);
  }

  /** The check's `require` of a module in the solution's tree. */
  requireModule(spec: string): unknown {
    const id = `r${this.seq++}`;
    this.send({ k: 'require', id, spec });
    const ret = this.pump(id);
    if (ret.ok !== true) throw this.rethrow(ret.error);
    return this.fromWire(ret.value);
  }

  fail(failure: string): void {
    if (this.failure !== undefined) return;
    this.failure = failure;
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    for (const waiter of this.failWaiters.splice(0)) waiter(failure);
  }

  /** Rejects when the boundary fails while the check is awaiting something. */
  async failed(): Promise<never> {
    if (this.failure !== undefined) throw new BoundaryFailure(this.failure);
    const failure = await new Promise<string>((resolve) => { this.failWaiters.push(resolve); });
    throw new BoundaryFailure(failure);
  }

  close(): void {
    if (this.closed) return;
    try { this.send({ k: 'done' }); } catch { /* the child is gone */ }
    this.closed = true;
    clearInterval(this.poller);
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    try { closeSync(this.inFd); } catch { /* already closed */ }
    try { closeSync(this.outFd); } catch { /* already closed */ }
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) throw new BoundaryFailure('the boundary is closed');
    let text: string;
    try { text = JSON.stringify(message); } catch { throw new BoundaryFailure('a value could not be serialized'); }
    writeSync(this.outFd, `${sign(this.key, text)} ${text}\n`);
  }

  /** A blocking pump: while the check's synchronous stack waits for the solution, the checker
   *  services the child's callbacks and reads its replies, sleeping a millisecond at a time. */
  private pump(id: string): RetMessage {
    for (;;) {
      this.drain();
      const got = this.rets.get(id);
      if (got !== undefined) { this.rets.delete(id); return got; }
      if (this.failure !== undefined) throw new BoundaryFailure(this.failure);
      if (Date.now() > this.deadline) {
        this.fail(`the check driver did not finish within ${this.timeoutMs} ms`);
        throw new BoundaryFailure(this.failure);
      }
      Atomics.wait(this.sleepCell, 0, 0, PUMP_SLEEP_MS);
    }
  }

  private poll(): void {
    if (this.closed) return;
    try { this.drain(); } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
    if (this.failure === undefined && Date.now() > this.deadline)
      this.fail(`the check driver did not finish within ${this.timeoutMs} ms`);
  }

  private drain(): void {
    let size: number;
    try { size = statSync(path.join(this.dir, 'to-checker.log')).size; } catch { return; }
    if (size <= this.offset) return;
    const chunk = Buffer.allocUnsafe(size - this.offset);
    const read = readSync(this.inFd, chunk, 0, chunk.length, this.offset);
    if (read <= 0) return;
    this.offset += read;
    this.total += read;
    if (this.total > MAX_TOTAL_BYTES)
      throw new BoundaryFailure(`the check driver wrote more than ${MAX_TOTAL_BYTES} bytes`);
    this.acc = Buffer.concat([this.acc, chunk.subarray(0, read)]);
    for (;;) {
      const nl = this.acc.indexOf(10);
      if (nl < 0) break;
      // The per-message cap is on the message, not only on a partial buffer: a line that is already
      // complete can still be too large to read.
      if (nl > MAX_MESSAGE_BYTES)
        throw new BoundaryFailure(`the check driver wrote a message larger than ${MAX_MESSAGE_BYTES} bytes`);
      const line = this.acc.subarray(0, nl).toString('utf8');
      this.acc = this.acc.subarray(nl + 1);
      this.receive(line);
    }
    if (this.acc.length > MAX_MESSAGE_BYTES)
      throw new BoundaryFailure(`the check driver wrote a message larger than ${MAX_MESSAGE_BYTES} bytes`);
  }

  private receive(line: string): void {
    const space = line.indexOf(' ');
    if (space < 0) return;
    const signature = line.slice(0, space);
    const text = line.slice(space + 1);
    if (!verify(this.key, text, signature)) return; // a line the driver did not write.
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    const kind = message['k'];
    if (kind === 'bye') {
      const why = message['message'];
      this.fail(typeof why === 'string'
        ? `the check driver exited before it finished: ${why}`
        : 'the check driver exited before it finished');
      return;
    }
    if (kind === 'settled') {
      const settled = message as unknown as SettledMessage;
      const pid = String(settled.pid);
      const waiter = this.settledWaiters.get(pid);
      // The same race as the driver's: a settlement can be read in the same drain as the reply
      // that named it, before the caller has a promise to settle.
      if (waiter !== undefined) { this.settledWaiters.delete(pid); waiter(settled); }
      else this.settledEarly.set(pid, settled);
      return;
    }
    if (kind === 'ret') { this.rets.set(String(message['id']), message as unknown as RetMessage); return; }
    if (kind === 'call') { this.serve(message); return; }
  }

  /** A check-side function the solution called. It runs here, in the checker. */
  private serve(message: Record<string, unknown>): void {
    const id = String(message['id']);
    const fn = this.callbacks.get(String(message['fid']));
    const reply = (body: Record<string, unknown>): void => { this.send({ k: 'ret', id, ...body }); };
    if (fn === undefined) { reply({ ok: false, error: { name: 'Error', message: 'no such check callback' } }); return; }
    let result: unknown;
    try {
      const raw = message['args'];
      const args = Array.isArray(raw) ? (raw as WireValue[]).map((a) => this.fromWire(a)) : [];
      const self = message['self'] === undefined ? undefined : this.fromWire(message['self'] as WireValue);
      result = fn.apply(self, args);
    } catch (err) { reply({ ok: false, error: errorOf(err) }); return; }
    if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
      const pid = `q${this.seq++}`;
      reply({ ok: true, pending: true, pid });
      const settle = (body: Record<string, unknown>): void => {
        try { this.send({ k: 'settled', pid, ...body }); } catch { /* the boundary is closed */ }
      };
      Promise.resolve(result).then(
        (value) => settle({ ok: true, value: this.toWire(value) }),
        (err: unknown) => settle({ ok: false, error: errorOf(err) }),
      );
      return;
    }
    let value: WireValue;
    try { value = this.toWire(result); } catch {
      reply({ ok: false, error: { name: 'Error', message: 'a check callback returned a value that cannot cross' } });
      return;
    }
    reply({ ok: true, value });
  }

  private promiseFor(pid: string): Promise<unknown> {
    const settle = (message: SettledMessage): unknown => {
      if (message.ok === true) return this.fromWire(message.value);
      throw this.rethrow(message.error);
    };
    const early = this.settledEarly.get(pid);
    if (early !== undefined) {
      this.settledEarly.delete(pid);
      return new Promise((resolve, reject) => {
        try { resolve(settle(early)); } catch (err) { reject(err); }
      });
    }
    return new Promise((resolve, reject) => {
      this.settledWaiters.set(pid, (message) => {
        if (message.ok === true) resolve(this.fromWire(message.value));
        else reject(this.rethrow(message.error));
      });
    });
  }

  private applyStates(ret: RetMessage): void {
    if (!Array.isArray(ret.states)) return;
    for (const state of ret.states) this.fromWire(state);
  }

  /* ---------- values ---------- */

  private toWire(value: unknown, seen: Map<object, string> = new Map()): WireValue {
    if (value === undefined) return { t: 'u' };
    if (value === null) return null;
    const type = typeof value;
    if (type === 'boolean' || type === 'string') return value as boolean | string;
    if (type === 'number') {
      const n = value as number;
      if (Number.isNaN(n)) return { t: 'n', v: 'NaN' };
      if (n === Infinity) return { t: 'n', v: 'Infinity' };
      if (n === -Infinity) return { t: 'n', v: '-Infinity' };
      if (n === 0 && 1 / n === -Infinity) return { t: 'n', v: '-0' };
      return n;
    }
    if (type === 'bigint') return { t: 'i', v: String(value) };
    if (type === 'symbol') return { t: 'y', d: String((value as symbol).description) };
    if (type === 'function') {
      const known = this.childFidByProxy.get(value as object);
      if (known !== undefined) return { t: 'F', id: known };
      let fid = this.fnIds.get(value as object);
      if (fid === undefined) {
        fid = `cf${this.fnSeq++}`;
        this.fnIds.set(value as object, fid);
        this.callbacks.set(fid, value as (...args: unknown[]) => unknown);
      }
      return { t: 'F', id: fid };
    }
    const object = value as object;
    const earlier = seen.get(object);
    if (earlier !== undefined) return { t: 'X', id: earlier };
    let id = this.objIds.get(object);
    if (id === undefined) { id = `c${this.seq++}`; this.objIds.set(object, id); }
    this.objects.set(id, value);
    seen.set(object, id);
    if (value instanceof Date) return { t: 'D', v: String(value.getTime()) };
    if (value instanceof RegExp) return { t: 'R', s: value.source, f: value.flags };
    if (value instanceof Error) return { t: 'E', n: String(value.name), m: String(value.message) };
    if (Array.isArray(value)) {
      const items: WireValue[] = [];
      for (let i = 0; i < value.length; i++) items[i] = i in value ? this.toWire(value[i], seen) : { t: 'H' };
      return { t: 'A', id, v: items };
    }
    if (ArrayBuffer.isView(value)) {
      if (Buffer.isBuffer(value)) return { t: 'V', id, k: 'Buffer', b: value.toString('base64') };
      const view = value as unknown as ArrayLike<unknown>;
      const items: WireValue[] = [];
      for (let i = 0; i < view.length; i++) items[i] = this.toWire(view[i], seen);
      const name = Object.prototype.toString.call(value).slice(8, -1);
      return { t: 'V', id, k: name, v: items };
    }
    if (value instanceof Map) {
      const entries: WireValue[] = [];
      for (const [k, v] of value) entries.push([this.toWire(k, seen), this.toWire(v, seen)] as unknown as WireValue);
      return { t: 'M', id, v: entries };
    }
    if (value instanceof Set) {
      const entries: WireValue[] = [];
      for (const v of value) entries.push(this.toWire(v, seen));
      return { t: 'S', id, v: entries };
    }
    const props: Array<[string, WireValue]> = [];
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) props.push([key, this.toWire(record[key], seen)]);
    const methods: Array<[string, WireValue]> = [];
    // A mirror keeps the solution's methods as own non-enumerable properties, so they must travel
    // as methods or the next call into the solution finds `this.method` missing. `constructor` is
    // the mirror's class name, materialised separately.
    for (const key of Object.getOwnPropertyNames(record)) {
      if (Object.prototype.propertyIsEnumerable.call(record, key)) continue;
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor !== undefined && typeof descriptor.value === 'function')
        methods.push([key, { t: 'F', id: this.childFidByProxy.get(descriptor.value) ?? this.fnIdFor(descriptor.value) }]);
    }
    const ownProto = Object.getPrototypeOf(object) as object | null;
    let proto = ownProto;
    let depth = 0;
    while (proto !== null && proto !== Object.prototype && depth < 8) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor' || key === '__proto__') continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor === undefined) continue;
        if (typeof descriptor.value === 'function')
          methods.push([key, { t: 'F', id: this.childFidByProxy.get(descriptor.value) ?? this.fnIdFor(descriptor.value) }]);
        else if (descriptor.get !== undefined || descriptor.set !== undefined) methods.push([key, { t: 'G' }]);
      }
      proto = Object.getPrototypeOf(proto) as object | null;
      depth++;
    }
    const out: Record<string, unknown> = { t: 'O', id, p: props };
    if (methods.length > 0) out['m'] = methods;
    if (ownProto === null) out['np'] = true;
    else {
      const ctor = (ownProto as { constructor?: { name?: unknown } }).constructor;
      if (ctor !== undefined && typeof ctor.name === 'string') out['cn'] = ctor.name;
    }
    return out;
  }

  private fnIdFor(fn: (...args: unknown[]) => unknown): string {
    const known = this.fnIds.get(fn);
    if (known !== undefined) return known;
    const fid = `cf${this.fnSeq++}`;
    this.fnIds.set(fn, fid);
    this.callbacks.set(fid, fn);
    return fid;
  }

  private fromWire(wire: WireValue | undefined): unknown {
    if (wire === undefined) return undefined;
    if (wire === null || typeof wire !== 'object') return wire;
    const t = wire['t'];
    switch (t) {
      case 'u': return undefined;
      case 'n': return NUMBERS[String(wire['v'])];
      case 'i': return BigInt(String(wire['v']));
      case 'y': return Symbol(String(wire['d']));
      case 'D': return new Date(Number(wire['v']));
      case 'R': return new RegExp(String(wire['s']), String(wire['f']));
      case 'E': return this.rethrow({ name: String(wire['n']), message: String(wire['m']) });
      case 'P': return Promise.resolve(undefined);
      case 'F': {
        const id = String(wire['id']);
        return this.callbacks.get(id) ?? this.fnProxy(id);
      }
      case 'X': return this.objects.get(String(wire['id']));
      case 'H': return undefined;
      default: break;
    }
    const id = String(wire['id']);
    if (t === 'A') {
      let array = this.objects.get(id) as unknown[] | undefined;
      if (array === undefined) { array = new Array((wire['v'] as WireValue[]).length); this.objects.set(id, array); }
      const items = wire['v'] as WireValue[];
      array.length = items.length;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item !== null && typeof item === 'object' && item['t'] === 'H') delete array[i];
        else array[i] = this.fromWire(item);
      }
      return array;
    }
    if (t === 'V') {
      const kind = String(wire['k']);
      if (kind === 'Buffer') {
        let buffer = this.objects.get(id) as Buffer | undefined;
        if (buffer === undefined) { buffer = Buffer.from(String(wire['b']), 'base64'); this.objects.set(id, buffer); }
        return buffer;
      }
      const Ctor = VIEW_CTORS[kind];
      if (Ctor === undefined) return {};
      const values = (wire['v'] as WireValue[]).map((v) => this.fromWire(v) as number);
      let view = this.objects.get(id) as { [i: number]: number; length: number } | undefined;
      if (view === undefined) {
        view = new Ctor(values.length) as unknown as { [i: number]: number; length: number };
        this.objects.set(id, view);
      }
      for (let i = 0; i < values.length; i++) view[i] = values[i] as number;
      return view;
    }
    if (t === 'M') {
      let map = this.objects.get(id) as Map<unknown, unknown> | undefined;
      if (map === undefined) { map = new Map(); this.objects.set(id, map); }
      map.clear();
      for (const [k, v] of wire['v'] as Array<[WireValue, WireValue]>) map.set(this.fromWire(k), this.fromWire(v));
      return map;
    }
    if (t === 'S') {
      let set = this.objects.get(id) as Set<unknown> | undefined;
      if (set === undefined) { set = new Set(); this.objects.set(id, set); }
      set.clear();
      for (const v of wire['v'] as WireValue[]) set.add(this.fromWire(v));
      return set;
    }
    // An object the solution owns already has a mirror; the wire carries its current contents.
    let mirror = this.objects.get(id) as Record<string, unknown> | undefined;
    if (mirror === undefined) {
      mirror = wire['np'] === true ? Object.create(null) as Record<string, unknown> : {};
      this.objects.set(id, mirror);
    }
    const props = wire['p'] as Array<[string, WireValue]>;
    const keep = new Set(props.map(([key]) => key));
    for (const key of Object.keys(mirror)) if (!keep.has(key)) delete mirror[key];
    for (const [key, value] of props) mirror[key] = this.fromWire(value);
    const methods = wire['m'] as Array<[string, WireValue]> | undefined;
    if (methods !== undefined) {
      for (const [key, descriptor] of methods) {
        if (descriptor !== null && typeof descriptor === 'object' && descriptor['t'] === 'G') {
          if (!Object.prototype.hasOwnProperty.call(mirror, key))
            Object.defineProperty(mirror, key, {
              get: () => this.readProperty(id, key), enumerable: false, configurable: true,
            });
        } else if (!(key in mirror)) {
          Object.defineProperty(mirror, key, {
            value: this.fnProxy(String((descriptor as Record<string, unknown>)['id'])),
            enumerable: false, configurable: true, writable: true,
          });
        }
      }
    }
    const className = wire['cn'];
    if (typeof className === 'string' && !Object.prototype.hasOwnProperty.call(mirror, 'constructor'))
      Object.defineProperty(mirror, 'constructor', { value: named(className), enumerable: false, configurable: true });
    return mirror;
  }

  private fnProxy(fid: string): (...args: unknown[]) => unknown {
    const known = this.fnProxies.get(fid);
    if (known !== undefined) return known;
    const bridge = this;
    const proxy = new Proxy(function () { return undefined; }, {
      apply(_target, thisArg, args) { return bridge.invoke(fid, thisArg, args as unknown[], false); },
      construct(_target, args) { return bridge.invoke(fid, undefined, args as unknown[], true) as object; },
    }) as unknown as (...args: unknown[]) => unknown;
    this.fnProxies.set(fid, proxy);
    this.childFidByProxy.set(proxy, fid);
    return proxy;
  }

  private rethrow(record: { name?: string; message?: string } | undefined): Error {
    const error = new Error(record?.message === undefined ? 'the solution raised an error' : record.message);
    if (record?.name !== undefined) error.name = record.name;
    return error;
  }
}

/* ---------- signing ---------- */

function sign(key: string, text: string): string {
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

function verify(key: string, text: string, signature: string): boolean {
  const expected = sign(key, text);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
}

/* ---------- running one check ---------- */

function errorOf(e: unknown): { name: string; message: string } {
  try {
    const err = e as { name?: unknown; message?: unknown };
    return {
      name: typeof err?.name === 'string' ? err.name : typeof e,
      message: typeof err?.message === 'string' ? err.message : String(e),
    };
  } catch {
    return { name: 'unknown', message: 'unserializable error' };
  }
}

function named(name: string): (...args: unknown[]) => unknown {
  const holder: Record<string, () => undefined> = { [name]: () => undefined };
  return holder[name] as (...args: unknown[]) => unknown;
}

/** The assertion recorder. It records what the check asserted; `compareObservations` judges it. */
function makeAssert(
  loose: boolean, observations: CheckObservation[],
): { assert: Record<string, (...args: never[]) => void>; pending: Promise<void>[] } {
  const emit = (op: AssertOp, actual: unknown, expected: unknown, extra?: Record<string, unknown>): void => {
    const record: CheckObservation = { op, loose, a: ser(actual, []) };
    if (expected !== undefined || op === 'equal' || op === 'notEqual' || op === 'deepEqual' ||
      op === 'notDeepEqual' || op === 'throws' || op === 'rejects')
      record.e = expected === undefined ? { t: 'u' } : ser(expected, []);
    if (extra !== undefined) Object.assign(record, extra);
    observations.push(record);
  };
  // R9-L4: `assert.throws(fn, TypeError)` names a constructor. The error itself crosses the
  // boundary as `{name, message}`, so the name is the part of the contract that can be compared
  // here; an old expectation recorded before this carries no `errType` and only requires a throw.
  const errTypeOf = (expected: unknown): string | undefined => {
    if (typeof expected !== 'function') return undefined;
    const name = (expected as { name?: unknown }).name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  };
  const pending: Promise<void>[] = [];
  const assert: Record<string, (...args: never[]) => void> = {
    equal(actual: never, expected: never) { emit('equal', actual, expected, { same: actual === expected }); },
    notEqual(actual: never, expected: never) { emit('notEqual', actual, expected, { same: actual === expected }); },
    deepEqual(actual: never, expected: never) { emit('deepEqual', actual, expected); },
    deepStrictEqual(actual: never, expected: never) { emit('deepEqual', actual, expected); },
    notDeepEqual(actual: never, expected: never) { emit('notDeepEqual', actual, expected); },
    strictEqual(actual: never, expected: never) { emit('equal', actual, expected, { same: actual === expected }); },
    notStrictEqual(actual: never, expected: never) { emit('notEqual', actual, expected, { same: actual === expected }); },
    ok(actual: never) { emit('ok', actual, true); },
    throws(fn: never, expected: never) {
      let threw = false;
      let err: { name: string; message: string } | undefined;
      try { (fn as unknown as () => void)(); } catch (e) { threw = true; err = errorOf(e); }
      const record: CheckObservation = {
        op: 'throws', loose, a: null,
        e: expected === undefined ? { t: 'u' } : ser(expected, []), threw,
      };
      if (threw && err !== undefined) record.err = err;
      const errType = errTypeOf(expected);
      if (errType !== undefined) record.errType = errType;
      observations.push(record);
    },
    doesNotThrow(fn: never, expected: never) {
      let threw = false;
      let err: { name: string; message: string } | undefined;
      try { (fn as unknown as () => void)(); } catch (e) { threw = true; err = errorOf(e); }
      const record: CheckObservation = {
        op: 'throws', loose, a: null,
        e: expected === undefined ? { t: 'u' } : ser(expected, []), threw, negate: true,
      };
      if (threw && err !== undefined) record.err = err;
      observations.push(record);
    },
    rejects(promise: never, expected: never) {
      const settled = (async (): Promise<void> => {
        let threw = false;
        let err: { name: string; message: string } | undefined;
        try { await promise; } catch (e) { threw = true; err = errorOf(e); }
        const record: CheckObservation = {
          op: 'rejects', loose, a: null,
          e: expected === undefined ? { t: 'u' } : ser(expected, []), threw,
        };
        if (threw && err !== undefined) record.err = err;
        const errType = errTypeOf(expected);
        if (errType !== undefined) record.errType = errType;
        observations.push(record);
      })();
      pending.push(settled);
      return settled as unknown as void;
    },
    match(actual: never, expected: never) {
      emit('ok', typeof actual === 'string' && new RegExp(expected as unknown as string).test(actual), true);
    },
    fail(message: never) {
      observations.push({ op: 'ok', loose, a: false, e: true });
      void message;
    },
  };
  return { assert, pending };
}

/** A value as an observation reports it. Runs on checker-side values only. */
function ser(value: unknown, seen: unknown[]): SerializedValue {
  const t = typeof value;
  if (t === 'undefined') return { t: 'u' };
  if (value === null) return null;
  if (t === 'boolean' || t === 'string') return value as boolean | string;
  if (t === 'number') {
    const n = value as number;
    if (Number.isNaN(n)) return { t: 'n', v: 'NaN' };
    if (n === Infinity) return { t: 'n', v: 'Infinity' };
    if (n === -Infinity) return { t: 'n', v: '-Infinity' };
    if (n === 0 && 1 / n === -Infinity) return { t: 'n', v: '-0' };
    return n;
  }
  if (t === 'bigint') return { t: 'i', v: String(value) };
  if (t === 'symbol') return { t: 'y', v: String((value as symbol).description) };
  if (t === 'function') return { t: 'f' };
  for (let i = 0; i < seen.length; i++) if (seen[i] === value) return { t: 'c' };
  seen.push(value);
  try {
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object Date]') return { t: 'd', v: String((value as Date).getTime()) };
    if (tag === '[object RegExp]') {
      const re = value as RegExp;
      return { t: 'r', v: { source: re.source, flags: re.flags } };
    }
    if (tag === '[object Error]') {
      const err = value as Error;
      return { t: 'e', v: { name: String(err.name), message: String(err.message) } };
    }
    if (Array.isArray(value)) {
      const out: SerializedValue[] = [];
      for (let i = 0; i < value.length; i++) out[i] = i in value ? ser(value[i], seen) : { t: 'h' };
      return { t: 'a', v: out };
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as unknown as ArrayLike<unknown>;
      const out: SerializedValue[] = [];
      for (let i = 0; i < view.length; i++) out[i] = ser(view[i], seen);
      return { t: 'b', k: Object.prototype.toString.call(value).slice(8, -1), v: out };
    }
    if (value instanceof Map) {
      const entries: Array<[SerializedValue, SerializedValue]> = [];
      for (const [k, v] of value) entries.push([ser(k, seen), ser(v, seen)]);
      return { t: 'm', v: entries };
    }
    if (value instanceof Set) {
      const entries: Array<[SerializedValue, SerializedValue]> = [];
      for (const v of value) entries.push([ser(v, seen), null]);
      return { t: 's', v: entries };
    }
    if (tag === '[object Promise]') return { t: 'p' };
    const props: Array<[string, SerializedValue]> = [];
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      let property: unknown;
      try { property = record[key]; } catch { property = undefined; }
      props.push([key, ser(property, seen)]);
    }
    const out: { t: 'o'; v: Array<[string, SerializedValue]>; c?: string } = { t: 'o', v: props };
    const ctor = (value as { constructor?: { name?: unknown } }).constructor;
    if (ctor !== undefined && typeof ctor.name === 'string') out.c = ctor.name;
    return out;
  } finally {
    seen.pop();
  }
}

const EXIT_SENTINEL = { hiddenCheckExit: true };
const CHECK_PARAMS = [
  'source', 'exports', 'require', 'module', '__filename', '__dirname', 'process', 'console',
];

/** The checker's own require, for a check that asks for a Node builtin. Only relative specifiers
 *  reach the solution's tree. */
const nodeRequire = createRequire(__filename);
const BUILTIN = /^(node:)?(assert|assert\/strict|path|url|util|buffer|fs|os|crypto|stream|string_decoder|events)$/;

/** Build-time: a train task's visible test may run against a starter that throws. Swallowed calls
 *  answer `undefined`; only the expected arguments matter, and those are literals. */
function proxyValue(value: unknown, cache: Map<unknown, unknown>): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const known = cache.get(value);
  if (known !== undefined) return known;
  const stub = function (): unknown { return undefined; };
  const proxy = new Proxy(value as object, {
    get(target, property) {
      if (property === Symbol.toPrimitive || property === 'then' || property === 'toJSON' || property === Symbol.iterator)
        return undefined;
      if (property in (target as object)) return proxyValue((target as Record<PropertyKey, unknown>)[property], cache);
      return stub;
    },
    apply() { return undefined; },
    construct() { return {}; },
  });
  cache.set(value, proxy);
  return proxy;
}

async function runCheck(
  source: string, bridge: CheckerBridge, repoDir: string, proxy: boolean,
): Promise<CheckObservation[]> {
  const observations: CheckObservation[] = [];
  const loose = makeAssert(true, observations);
  const strict = makeAssert(false, observations);
  const proxied = new Map<unknown, unknown>();

  const checkRequire = (id: string): unknown => {
    if (id === 'node:assert' || id === 'assert') return loose.assert;
    if (id === 'node:assert/strict' || id === 'assert/strict') return strict.assert;
    if (BUILTIN.test(id)) return nodeRequire(id);
    const loaded = bridge.requireModule(id);
    return proxy ? proxyValue(loaded, proxied) : loaded;
  };

  const checkModule = { exports: {} as unknown };
  const noop = function (): void { /* the check's own output is not the verdict */ };
  const checkProcess = {
    env: {}, argv: [] as string[], platform: process.platform, version: process.version,
    pid: bridge.pid,
    cwd(): string { return repoDir; },
    exit(code?: number): never {
      const status = typeof code === 'number' ? code : 0;
      observations.push({ op: 'exit', loose: true, a: status, e: 0 });
      throw EXIT_SENTINEL;
    },
    stdout: { write: noop }, stderr: { write: noop },
  };
  const noopConsole = { log: noop, error: noop, warn: noop, info: noop, debug: noop };

  // A direct eval, not a compiled body: the check's completion value is its last expression, and a
  // check written as an async IIFE returns that promise, which must be awaited. The eval runs in
  // this function's scope, so the shadowed names are parameters.
  const compiled = vm.compileFunction('return eval(source)', CHECK_PARAMS, { filename: 'hidden-check.js' });
  const noteStop = (e: unknown): void => {
    if (e === EXIT_SENTINEL) return;
    const err = errorOf(e);
    bridge.fail(`the check script stopped: ${err.name}: ${err.message}`);
  };
  let result: unknown;
  try {
    result = compiled(
      source, checkModule.exports, checkRequire, checkModule,
      path.join(repoDir, 'hidden-check.js'), repoDir, checkProcess, noopConsole,
    );
  } catch (e) { noteStop(e); }
  try { await result; } catch (e) { noteStop(e); }
  for (const outstanding of [...loose.pending, ...strict.pending]) {
    try { await outstanding; } catch (e) { noteStop(e); }
  }
  return observations;
}

/**
 * Runs the check against the solution in `repoDir`. The check runs here; the solution runs in a
 * child that receives call descriptions only. Returns what the check observed; a boundary that
 * fails — the child missing, hung, exited early, or over the output cap — returns a failure, and a
 * failure is never a pass.
 */
export async function runHiddenCheck(
  source: string, repoDir: string, opts: { timeoutMs?: number } = {},
): Promise<{ observations: CheckObservation[]; failure?: string }> {
  return await runBoundary(source, repoDir, { proxy: false, ...opts });
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
  const run = await runBoundary(source, repoDir, {
    proxy: opts.proxy === true,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
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
    if (o.errType !== undefined) e.errType = o.errType;
    expectations.push(e);
  }
  return { expectations, ...(exitStyle ? { exitStyle: true } : {}) };
}

async function runBoundary(
  source: string, repoDir: string, opts: { proxy: boolean; timeoutMs?: number },
): Promise<{ observations: CheckObservation[]; failure?: string }> {
  const timeoutMs = opts.timeoutMs ?? OBSERVATION_TIMEOUT_MS;
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-hidden-'));
  const key = crypto.randomBytes(32).toString('hex');
  let bridge: CheckerBridge | undefined;
  try {
    await writeFile(path.join(dir, 'to-child.log'), '', 'utf8');
    await writeFile(path.join(dir, 'to-checker.log'), '', 'utf8');
    const driverPath = path.join(dir, 'driver.cjs');
    await writeFile(driverPath, DRIVER_SOURCE, 'utf8');
    const child = spawn(process.execPath, ['--disallow-code-generation-from-strings', driverPath], {
      cwd: repoDir,
      env: toolEnv(),
      stdio: ['pipe', 'ignore', 'ignore', 'ignore'],
    });
    bridge = new CheckerBridge({ child, dir, key, timeoutMs });
    // The driver reads this once, before any solution code exists, and keeps it in its own scope.
    const config = JSON.stringify({ key, dir, repoDir });
    await new Promise<void>((resolve, reject) => {
      child.stdin?.on('error', reject);
      child.stdin?.end(config, () => resolve());
    });
    await waitReady(bridge, timeoutMs);

    const check = runCheck(source, bridge, repoDir, opts.proxy);
    const observations = await Promise.race([check, bridge.failed()]);
    if (bridge.failure !== undefined) return { observations: [], failure: bridge.failure };
    return { observations };
  } catch (err) {
    return { observations: [], failure: err instanceof Error ? err.message : String(err) };
  } finally {
    bridge?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Waits for the driver's first signed line: it is up, and nothing has loaded the solution yet. */
async function waitReady(bridge: CheckerBridge, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  for (;;) {
    if (bridge.failure !== undefined) throw new BoundaryFailure(bridge.failure);
    if (bridge.ready) return;
    if (Date.now() > deadline) throw new BoundaryFailure('the check driver did not start');
    await new Promise((resolve) => setTimeout(resolve, PUMP_SLEEP_MS));
  }
}

/* ---------- comparing observations ---------- */

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
 * reference identity was decided where the check ran, which is now the checker.
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
      // R9-L4: `deepStrictEqual` compares Maps and Sets without regard to insertion order; an
      // entry-by-entry scan judged two equal collections unequal when they were built differently.
      const av = ao['v'] as Array<[SerializedValue, SerializedValue]>;
      const ev = eo['v'] as Array<[SerializedValue, SerializedValue]>;
      if (av.length !== ev.length) return false;
      const used = new Array<boolean>(ev.length).fill(false);
      return av.every((pair) => {
        for (let j = 0; j < ev.length; j++) {
          if (used[j] === true) continue;
          const other = ev[j] as [SerializedValue, SerializedValue];
          if (deepSerializedEqual(pair[0], other[0], loose) && deepSerializedEqual(pair[1], other[1], loose)) {
            used[j] = true;
            return true;
          }
        }
        return false;
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
      // R9-L4: `doesNotThrow` is the same observation with its verdict inverted. Judged as a throw
      // it passed exactly the solution that threw and failed the one that did not.
      if (o.negate === true) {
        if (o.threw !== true) continue;
        const what = o.err === undefined ? 'an error' : `${o.err.name}: ${o.err.message}`;
        return { passed: false, detail: `assertion ${i + 1}: doesNotThrow saw ${what}` };
      }
      if (o.threw !== true) return { passed: false, detail: `assertion ${i + 1}: expected a throw, none was raised` };
      const expected = e.e;
      if (expected !== undefined && expected !== null && typeof expected === 'object' && (expected as { t?: string }).t === 'r') {
        const { source, flags } = (expected as { v: { source: string; flags: string } }).v;
        const re = new RegExp(source, flags);
        const message = o.err?.message ?? '';
        if (!re.test(message) && !new RegExp(source, flags).test(String(o.err?.name ?? '')))
          return { passed: false, detail: `assertion ${i + 1}: ${JSON.stringify(message)} does not match ${re}` };
      } else if (e.errType !== undefined) {
        // R9-L4: a constructor was named; the error's class is part of the contract.
        const got = o.err?.name ?? '';
        if (got !== e.errType)
          return {
            passed: false,
            detail: `assertion ${i + 1}: threw ${got === '' ? 'an unnamed error' : got}, expected ${e.errType}`,
          };
      } else if (expected !== undefined && expected !== null && typeof expected === 'object' && (expected as { t?: string }).t === 'f') {
        // An expectation recorded before errType existed: a throw is the contract.
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
