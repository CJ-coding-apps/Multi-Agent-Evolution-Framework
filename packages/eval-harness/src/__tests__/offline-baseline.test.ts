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
  assert.deepEqual(result.solvedTaskIds, ['coder-sum', 'coder-reverse', 'coder-clamp', 'coder-isodd']);
  const capitalize = result.tasks.find((t) => t.taskId === 'coder-capitalize')?.attempts[0]?.outcomes;
  assert.deepEqual(capitalize?.map((o) => [o.kind, o.passed]), [['must-not-modify', false], ['test-script', true]],
    'the scripted coder that rewrites test.js passes its test and must still fail');
  assert.equal(result.judge?.distinct, false);
});
