#!/usr/bin/env node
// The goldens baseline comparator, for the CI end-to-end job (D-24).
//
// `goldens run --adapter scripted` replays a fixed script against the committed corpus under the
// committed default harness, so on a fresh checkout every field of its result is determined but
// one: `ranAt`, the wall-clock time it ran. This compares a result to the committed baseline field
// by field, ignoring that one top-level field, and exits 1 on any other difference. A task that
// newly passes is a difference too: either the baseline is stale or behaviour moved, and both call
// for a person to look and then update the baseline deliberately, in the commit that moved it.
//
// It is the strict sibling of `maf goldens compare`, not a replacement. `compare` asks whether a
// candidate regresses on the baseline's solved set (the seesaw); this asks whether anything changed.
//
// Usage:  node scripts/compare-goldens.mjs <baseline.json> <result.json>
//         node scripts/compare-goldens.mjs --self-test
// Exit:   0 identical but for ranAt · 1 they differ · 2 a file is missing, is not JSON, or is not a
//         golden result — nothing was compared, so nothing can be said to match.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/** The top-level fields two runs may differ in. Only the timestamp; everything else is determined. */
const IGNORED = new Set(['ranAt']);
const MAX_SHOWN = 20;

class Refusal extends Error {}

function kindOf(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function show(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Every place `a` (the baseline) and `b` (the result) differ, one line each. Key order is not a
 * difference, because JSON objects have none; array order is, because `solvedTaskIds` and the
 * attempts are ordered.
 */
function differences(a, b, at = '$', out = []) {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    out.push(`${at}: the baseline has ${show(a)}, the result has ${show(b)}`);
  } else if (ka === 'array') {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const p = `${at}[${i}]`;
      if (i >= b.length) out.push(`${p}: in the baseline (${show(a[i])}), missing from the result`);
      else if (i >= a.length) out.push(`${p}: in the result (${show(b[i])}), not in the baseline`);
      else differences(a[i], b[i], p, out);
    }
  } else if (ka === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
      if (!Object.hasOwn(b, key)) out.push(`${p}: in the baseline (${show(a[key])}), missing from the result`);
      else if (!Object.hasOwn(a, key)) out.push(`${p}: in the result (${show(b[key])}), not in the baseline`);
      else differences(a[key], b[key], p, out);
    }
  } else if (a !== b) {
    out.push(`${at}: the baseline has ${show(a)}, the result has ${show(b)}`);
  }
  return out;
}

/** `differences`, with the ignored top-level fields taken out of both sides first. */
function compareResults(baseline, result) {
  const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !IGNORED.has(k)));
  return differences(strip(baseline), strip(result));
}

/** Reads a golden result, refusing a file that is unreadable, not JSON, or not shaped like one. */
function load(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Refusal(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Refusal(`${file} is not JSON: ${err instanceof Error ? err.message : String(err)}.`);
  }
  // The same fields `goldens compare` demands. Without them two empty objects would "match".
  const o = kindOf(value) === 'object' ? value : {};
  const missing = ['tasks', 'solvedTaskIds'].filter((k) => !Array.isArray(o[k]));
  if (typeof o.harnessSha !== 'string') missing.unshift('harnessSha');
  if (missing.length > 0) {
    throw new Refusal(`${file} is not a golden result: it has no valid ${missing.join(', ')}.`);
  }
  return value;
}

function compareFiles(baselineFile, resultFile) {
  let baseline;
  let result;
  try {
    baseline = load(baselineFile);
    result = load(resultFile);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    console.error(`[compare-goldens] ${err.message}`);
    return 2;
  }
  const diffs = compareResults(baseline, result);
  if (diffs.length === 0) {
    console.log(
      `[compare-goldens] ${resultFile} matches ${baselineFile} (ranAt ignored): ` +
      `solved ${result.solvedTaskIds.length}/${result.tasks.length}.`,
    );
    return 0;
  }
  console.error(`[compare-goldens] ${resultFile} differs from ${baselineFile} in ${diffs.length} place(s):`);
  for (const d of diffs.slice(0, MAX_SHOWN)) console.error(`  ${d}`);
  if (diffs.length > MAX_SHOWN) console.error(`  ... and ${diffs.length - MAX_SHOWN} more`);
  console.error(
    '[compare-goldens] If the change is intended, copy the result over the baseline in the commit that caused it.',
  );
  return 1;
}

function selfTest() {
  const attempt = (n, passed) => ({ attempt: n, output: 'Fixed sum.js.', outcomes: [{ kind: 'test-script', passed, detail: 'node exited 0' }], passed });
  const baseline = {
    harnessSha: 'a'.repeat(64), harnessId: 'default', corpusSha: 'c'.repeat(64), attempts: 2, adapter: 'scripted',
    tasks: [
      { taskId: 'coder-sum', role: 'coder', passed: true, attempts: [attempt(0, true), attempt(1, true)] },
      { taskId: 'review-loop', role: 'reviewer', passed: false, attempts: [attempt(0, false), attempt(1, false)] },
    ],
    solvedTaskIds: ['coder-sum'],
    ranAt: '2026-10-08T17:53:56.319Z',
  };
  const copy = () => structuredClone(baseline);

  // What must match.
  assert.deepEqual(compareResults(baseline, copy()), [], 'a result equal to its baseline');
  assert.deepEqual(compareResults(baseline, { ...copy(), ranAt: '2027-01-01T00:00:00.000Z' }), [], 'ranAt is ignored');
  const { ranAt: _ranAt, ...noRanAt } = copy();
  assert.deepEqual(compareResults(baseline, noRanAt), [], 'a missing ranAt is ignored too');
  const reordered = Object.fromEntries(Object.entries(copy()).reverse());
  assert.deepEqual(compareResults(baseline, reordered), [], 'key order is not a difference');

  // What must not.
  const flipped = copy();
  flipped.tasks[0].attempts[1].passed = false;
  assert.deepEqual(compareResults(baseline, flipped), ['$.tasks[0].attempts[1].passed: the baseline has true, the result has false']);
  const solvedMore = copy();
  solvedMore.solvedTaskIds.push('review-loop');
  assert.deepEqual(compareResults(baseline, solvedMore), ['$.solvedTaskIds[1]: in the result ("review-loop"), not in the baseline'], 'a newly solved task is a difference');
  const solvedLess = copy();
  solvedLess.solvedTaskIds.pop();
  assert.deepEqual(compareResults(baseline, solvedLess), ['$.solvedTaskIds[0]: in the baseline ("coder-sum"), missing from the result']);
  const { corpusSha: _c, ...noCorpus } = copy();
  assert.deepEqual(compareResults(baseline, noCorpus), [`$.corpusSha: in the baseline ("${'c'.repeat(64)}"), missing from the result`]);
  assert.deepEqual(compareResults(baseline, { ...copy(), model: 'm' }), ['$.model: in the result ("m"), not in the baseline']);
  assert.deepEqual(compareResults(baseline, { ...copy(), attempts: '2' }), ['$.attempts: the baseline has 2, the result has "2"'], 'a type change is a difference');
  const nested = copy();
  nested.tasks[1].ranAt = 'x';
  assert.equal(compareResults(baseline, nested).length, 1, 'only the top-level ranAt is ignored');
  const swapped = copy();
  swapped.tasks.reverse();
  assert.ok(compareResults(baseline, swapped).length > 0, 'task order is a difference');
  assert.deepEqual(differences({ 'a-b': null }, { 'a-b': {} }), ['$["a-b"]: the baseline has null, the result has {}']);

  // The command, as the CI job runs it.
  const dir = mkdtempSync(path.join(tmpdir(), 'compare-goldens-'));
  try {
    const write = (name, value) => {
      const file = path.join(dir, name);
      writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
      return file;
    };
    const run = (...args) => spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8' });
    const base = write('baseline.json', baseline);
    const same = run(base, write('same.json', { ...copy(), ranAt: 'later' }));
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /matches .* \(ranAt ignored\): solved 1\/2\./);
    const differs = run(base, write('flipped.json', flipped));
    assert.equal(differs.status, 1, differs.stdout);
    assert.match(differs.stderr, /differs from .* in 1 place\(s\):\n {2}\$\.tasks\[0\]\.attempts\[1\]\.passed: /);
    for (const [label, file, reason] of [
      ['a missing result', path.join(dir, 'nope.json'), /cannot read .*nope\.json: /],
      ['a result that is not JSON', write('torn.json', '{"harnessSha": "a'), /torn\.json is not JSON: /],
      ['an empty object', write('empty.json', {}), /empty\.json is not a golden result: it has no valid harnessSha, tasks, solvedTaskIds\./],
    ]) {
      const r = run(base, file);
      assert.equal(r.status, 2, `${label} exits 2, not 0 or 1: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, reason, label);
    }
    assert.equal(run(base).status, 2, 'one argument is a usage error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('[compare-goldens] self-test passed.');
  return 0;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return selfTest();
  if (argv.length !== 2) {
    console.error('usage: node scripts/compare-goldens.mjs <baseline.json> <result.json> | --self-test');
    return 2;
  }
  return compareFiles(argv[0], argv[1]);
}

process.exitCode = main(process.argv.slice(2));
