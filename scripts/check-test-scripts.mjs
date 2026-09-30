#!/usr/bin/env node
// A5 — the test-script guard.
//
// `pnpm -r test` only runs packages that declare a `test` script, so a package with
// tests and no script is invisible: its tests pass, fail, or do not exist with equal
// silence. 15 of this repo's 28 packages are in exactly that position, which is why the
// "225 tests" headline said nothing about `dag-runner`, `prompt-injector`, `transcript`,
// `memory-graph` or the adapters.
//
// The guard therefore holds the invariant in BOTH directions:
//   * tests present, no script        -> FAIL (invisible tests)
//   * script present, but not running them -> FAIL (a script that lies, or that breaks
//                                              `pnpm -r test` with a dead glob)
// A package with neither is legal and is *named* in the output, so the untested surface
// is reported rather than quietly absent from the total.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join('src', '__tests__');

async function workspacePatterns() {
  const text = await readFile(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  return [...text.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
}

async function packageDirs() {
  const dirs = [];
  for (const pattern of await workspacePatterns()) {
    // "packages/*" and "packages/adapters/*": the parent is the pattern minus its last segment.
    const parent = path.join(ROOT, path.dirname(pattern));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const dir = path.join(parent, entry.name);
      if (await exists(path.join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function testFiles(dir) {
  const testsDir = path.join(dir, TESTS_DIR);
  if (!(await exists(testsDir))) return [];
  return (await readdir(testsDir)).filter((f) => f.endsWith('.test.ts')).sort();
}

const dirs = await packageDirs();
const problems = [];
const untested = [];
let tested = 0;

for (const dir of dirs) {
  const relative = path.relative(ROOT, dir);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const name = typeof pkg.name === 'string' ? pkg.name : relative;
  const script = pkg.scripts?.test;
  const hasScript = typeof script === 'string' && script.trim() !== '';
  const files = await testFiles(dir);

  if (files.length > 0 && !hasScript) {
    problems.push(`${name} (${relative}): ${files.length} test file(s) but no "test" script — they never run`);
    continue;
  }
  if (files.length === 0 && hasScript) {
    problems.push(`${name} (${relative}): has a "test" script but no ${TESTS_DIR}/*.test.ts — it either lies or fails the run`);
    continue;
  }
  if (files.length === 0) {
    untested.push(name);
    continue;
  }
  if (!script.includes('__tests__')) {
    problems.push(`${name} (${relative}): "test" script never mentions __tests__, so ${files.length} test file(s) are not what it runs: ${script}`);
    continue;
  }
  tested += 1;
}

for (const problem of problems) console.error(`FAIL  ${problem}`);

console.log(`test-script guard: ${tested}/${dirs.length} packages declare a test script that runs their ${TESTS_DIR} tests`);
if (untested.length > 0) {
  console.log(`no tests yet (${untested.length}): ${untested.join(', ')}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} package(s) violate the test-script invariant.`);
  process.exit(1);
}
console.log('OK');
