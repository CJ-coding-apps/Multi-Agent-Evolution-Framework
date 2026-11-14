import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GoldenRunner, ScriptedAdapter, assertGoldenCorpus, describeJudge, loadScriptedTasks, makeLlmJudge,
} from '../index.js';
import type { GoldenSuiteResult } from '../index.js';

// ORACLE: D-14 — the committed seed corpus, run by the scripted model, reproduces the committed
// baseline on any machine. This drives the scripted model as an opaque CLI agent, so it needs no
// LCM store; the CLI's end-to-end test (packages/cli goldens-offline) runs the same corpus through
// the full dispatch stack and checks the same file. Either one failing means the corpus, the
// scripts, a verifier or the judge contract changed what the baseline records.

const CORPUS = path.resolve(__dirname, '../../../../tests/goldens');

/** Everything but the wall clock. */
const stable = ({ ranAt: _ranAt, ...rest }: GoldenSuiteResult) => rest;

test('the scripted model reproduces the committed baseline from the committed corpus', async () => {
  const baseline = JSON.parse(await readFile(path.join(CORPUS, 'baseline.json'), 'utf8')) as GoldenSuiteResult;
  const corpus: unknown = JSON.parse(await readFile(path.join(CORPUS, 'corpus.json'), 'utf8'));
  assertGoldenCorpus(corpus);
  const scripted = new ScriptedAdapter(await loadScriptedTasks(CORPUS, corpus));
  const self = { adapter: scripted.name };

  const result = await new GoldenRunner({
    corpusRoot: CORPUS, harnessSha: baseline.harnessSha, harnessId: baseline.harnessId,
    attempts: 2, temperature: 0, ...self,
    dispatch: async (task, workDir, { timeoutMs }) =>
      (await scripted.invoke({ prompt: task.prompt, workingDir: workDir, timeoutMs })).output,
    llmJudge: { verdict: makeLlmJudge({ adapter: scripted }, CORPUS), disclosure: describeJudge(self, self) },
  }).run();

  assert.deepEqual(stable(result), stable(baseline));
  // What the baseline says, spelled out, so a regenerated baseline cannot quietly lose it.
  // R5-P1 grew the corpus to 116 tasks: 59 train, seven held-out (five deterministic, two judge) and
  // 50 pool candidates awaiting calibration. The scripted model solves exactly the tasks it answers
  // correctly — 50 of the train tasks including the fifteen R5-P1 additions, and the ten seed coder
  // tasks outside held-out. It fails coder-fib (its plain script is a wrong fix), every pool task
  // (each pool script is a plausible but wrong fix, so the base has no headroom there by
  // construction), and both judge tasks, because the scripted judge fails closed.
  assert.deepEqual(result.solvedTaskIds, [
    'coder-sum', 'coder-reverse', 'coder-clamp', 'coder-isodd', 'coder-repeat', 'coder-contains',
    'coder-max', 'coder-unique', 'coder-flatten', 'coder-pad',
    'train-crc8', 'train-bitset', 'train-rle', 'train-base32', 'train-intervals', 'train-heapify',
    'train-bloom', 'train-anagram', 'train-rot13', 'train-ring', 'train-grid-sum', 'train-title-case',
    'train-chunk', 'train-zip', 'train-prefix-sum', 'train-word-count', 'train-camel-keys',
    'train-template-render', 'train-graph-topo', 'train-move-file',
    'train-max-subarray', 'train-factorial', 'train-prime-sieve', 'train-rotate-array',
    'train-parse-binary', 'train-isbn-check', 'train-parse-bool', 'train-merge-sorted',
    'train-matrix-diagonal', 'train-hyphenate', 'train-calc-eval', 'train-dedupe', 'train-truncate',
    'train-split-path', 'train-mode',
    'train-invoice-two-file', 'train-router-two-file', 'train-state-machine-two-file',
    'train-config-two-file', 'train-pagination-two-file', 'train-feature-csv-writer',
    'train-feature-template', 'train-feature-retry', 'train-feature-rate-limit',
    'train-feature-deep-equal', 'train-bug-sort-comparator', 'train-bug-float-sum',
    'train-bug-utf8-truncate', 'train-bug-async-order', 'train-bug-object-keys',
  ]);
  const capitalize = result.tasks.find((t) => t.taskId === 'coder-capitalize')?.attempts[0]?.outcomes;
  assert.deepEqual(capitalize?.map((o) => [o.kind, o.passed]), [['must-not-modify', false], ['test-script', true]],
    'the scripted coder that rewrites test.js passes its test and must still fail');
  assert.equal(result.judge?.distinct, false);
});
