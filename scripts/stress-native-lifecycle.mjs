#!/usr/bin/env node
// The native-lifetime stress check (WP-2.15).
//
// `goldens run` puts both native stores in one process: the evaluation's Kùzu graph and
// better-sqlite3 LCM store, built and torn down by `runGoldenSuite`, then the project's graph for
// the score. This does exactly that N times in one process, on a fresh clone of the committed
// corpus, and collects garbage after every iteration so that whatever a torn-down stack left for
// the finalizers is finalized while the process keeps running — the condition under which a kuzu
// result that outlived its database corrupted the heap (`malloc(): unsorted double linked list
// corrupted`, SIGABRT). Each iteration must also still reproduce the committed baseline, so a
// stack that leaked state into the next one fails here too.
//
// Usage:  node scripts/stress-native-lifecycle.mjs [--iterations N]     (default 20; needs a build)
// Exit:   0 every iteration ran and matched the baseline · 1 one did not. A native crash kills
//         the process, so its absence is the other half of the verdict.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'tests/goldens');
const require = createRequire(path.join(ROOT, 'packages/cli/package.json'));
const { resolveGoldensAdapter, resolveGoldensHarness, runGoldenSuite } = require('./dist/commands/goldens.js');
const { ScoreRecorder } = require('@maf/eval-harness');
const { MemoryGraph } = require('@maf/memory-graph');
const { makeRunId } = require('@maf/types');

const flag = process.argv.indexOf('--iterations');
const iterations = flag === -1 ? 20 : Number(process.argv[flag + 1]);
if (!Number.isInteger(iterations) || iterations < 1) {
  console.error(`stress-native-lifecycle: --iterations takes a positive integer, not ${JSON.stringify(process.argv[flag + 1])}.`);
  process.exit(2);
}

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
/**
 * A full collection, then a turn of the loop (Node runs native finalizers from its check phase),
 * then some malloc traffic — a heap corrupted by a finalizer is usually noticed by a later,
 * unrelated allocation (in CI, `opendir`'s), not by the write that corrupted it.
 */
async function collect() {
  for (let pass = 0; pass < 2; pass++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let i = 0; i < 50; i++) readdirSync(tmpdir());
}

/** What a fresh clone gives goldens: the committed policy, default harness and corpus — no state. */
async function freshClone() {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-stress-'));
  await mkdir(path.join(root, '.maf/harnesses'), { recursive: true });
  await cp(path.join(ROOT, '.maf/policy.yaml'), path.join(root, '.maf/policy.yaml'));
  const names = (await readdir(path.join(ROOT, '.maf/harnesses'))).filter((n) => /^default-[0-9a-f]{64}\.json$/.test(n));
  assert.equal(names.length, 1, 'expected exactly one committed default harness');
  await cp(path.join(ROOT, '.maf/harnesses', names[0]), path.join(root, '.maf/harnesses', names[0]));
  await cp(SEED, path.join(root, 'tests/goldens'), { recursive: true });
  return root;
}

const stable = ({ ranAt: _ranAt, ...rest }) => rest;
const baseline = stable(JSON.parse(await readFile(path.join(SEED, 'baseline.json'), 'utf8')));

// One project for every iteration, as repeated `goldens run`s in one checkout would be: its graph
// is reopened each time, and each evaluation gets a temporary stack of its own.
const root = await freshClone();
let passed = 0;
try {
  const mafDir = path.join(root, '.maf');
  const corpusRoot = path.join(root, 'tests/goldens');
  for (let i = 1; i <= iterations; i++) {
    const runId = makeRunId(`stress-${i}`);
    const { harness, source } = await resolveGoldensHarness(mafDir);
    const agent = await resolveGoldensAdapter('scripted', corpusRoot);
    const { result } = await runGoldenSuite({
      cwd: root, corpusRoot, harness, harnessSource: source, agent, judge: { adapter: agent },
      attempts: 2, policyPath: path.join(mafDir, 'policy.yaml'), runId,
    });
    await collect(); // the evaluation's stack is garbage now, as it is when `goldens run` records the score
    const graph = new MemoryGraph(path.join(mafDir, 'memory.kuzu'));
    try {
      await new ScoreRecorder(graph, runId).record(result);
    } finally {
      graph.close();
    }
    assert.deepEqual(stable(result), baseline, `iteration ${i} did not reproduce the committed baseline`);
    await collect();
    passed++;
    console.log(`iteration ${i}/${iterations}: solved ${result.solvedTaskIds.length}/${result.tasks.length}, matches the baseline`);
  }
} catch (err) {
  console.error(`stress-native-lifecycle: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(`stress-native-lifecycle: ${passed}/${iterations} iterations in one process`);
process.exitCode = passed === iterations ? 0 : 1;
