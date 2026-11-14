#!/usr/bin/env node
// The held-out duplicate guard (R6-H2).
//
// Round 5 grew the pool by fifteen tasks that were byte-identical copies of fifteen new train
// tasks. A held-out or pool task that duplicates a train task does not measure generalisation: the
// evolver has already been scored on the same work under another name. Nothing caught it, because
// no check compared the splits against each other.
//
// This fails on a shared fixture file, a shared file after comments and whitespace are removed, a
// shared hidden check or reference, and on a fixture-file pair whose token similarity reaches
// NEAR_COPY_THRESHOLD (0.9). See packages/eval-harness/src/heldoutDuplicates.ts.
//
// Exit: 0 no duplicate · 1 one or more, listed · 2 the corpus or splits are unreadable.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'tests', 'goldens');

let harness;
try {
  harness = await import(pathToFileURL(path.join(ROOT, 'packages', 'eval-harness', 'dist', 'index.js')).href);
} catch (err) {
  console.error(`check-heldout-duplicates: cannot load @maf/eval-harness: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(path.join(CORPUS, file), 'utf8'));
  } catch (err) {
    console.error(`check-heldout-duplicates: ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
};

const corpus = await readJson('corpus.json');
const splits = await readJson('splits.json');
const report = await harness.findHeldOutDuplicates(CORPUS, corpus, splits);

if (report.findings.length > 0) {
  console.error('check-heldout-duplicates: a held-out or pool task duplicates a train task');
  for (const finding of report.findings)
    console.error(`  [${finding.kind}] ${finding.heldOut} vs train ${finding.train}: ${finding.detail}`);
  console.error(
    `  ${report.heldOutTasks} held-out/pool task(s) compared against ${report.trainTasks} train task(s); ` +
    `near-copy threshold ${report.threshold}`,
  );
  process.exit(1);
}

console.log(
  `check-heldout-duplicates: ${report.heldOutTasks} held-out/pool task(s) against ${report.trainTasks} ` +
  `train task(s); no shared file, normalized file, hidden check or reference; max token similarity ` +
  `${report.maxSimilarity.toFixed(3)} < ${report.threshold}`,
);
