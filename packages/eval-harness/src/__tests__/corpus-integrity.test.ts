import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GoldenRunner, assertGoldenCorpus, computeCorpusSha, describeJudge } from '../index.js';
import type { GoldenTask, TaskDispatcher } from '../index.js';

// ORACLE: D-14 — a result names the corpus it was measured on (sha over tasks AND the files they
// read), the attempts and the adapter; a coder task cannot pass by editing the test that scores
// it (`mustNotModify`); and evolve's smoke check runs the task it names, not whatever is first.

const TEST_JS = "const { sum } = require('./sum');\nif (sum(2,3) !== 5) process.exit(1);\n";

const CODER: GoldenTask = {
  id: 'coder-sum',
  repoFixture: 'fixtures/coder-sum',
  prompt: 'Fix sum.js so test.js passes.',
  role: 'coder',
  verifiers: [{ kind: 'test-script', command: 'node', args: ['test.js'], expectExit: 0 }],
  mustNotModify: ['test.js'],
  provenance: { source: 'human-decision', ref: 'test fixture' },
};
const OTHER: GoldenTask = { ...CODER, id: 'coder-other', mustNotModify: [] };

async function withCorpus(tasks: GoldenTask[], fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-integrity-'));
  try {
    const fixture = path.join(root, 'fixtures/coder-sum');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'sum.js'), 'exports.sum = (a, b) => a - b;\n', 'utf8');
    await writeFile(path.join(fixture, 'test.js'), TEST_JS, 'utf8');
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify(tasks), 'utf8');
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const runner = (root: string, dispatch: TaskDispatcher, attempts = 1) =>
  new GoldenRunner({ corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h', adapter: 'stub', attempts, dispatch });

test('the corpus sha covers fixture and rubric content, ignores key order and files no task reads', async () => {
  await withCorpus([CODER], async (root) => {
    const sha = () => computeCorpusSha(root, [CODER]);
    const first = await sha();
    assert.match(first, /^[0-9a-f]{64}$/);

    const reordered = Object.fromEntries(Object.entries(CODER).reverse()) as unknown as GoldenTask;
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(CODER));
    assert.equal(await computeCorpusSha(root, [reordered]), first, 'key order is not content');

    await writeFile(path.join(root, 'baseline.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'scripted.json'), '{}', 'utf8');
    assert.equal(await sha(), first, 'files beside the corpus that no task reads are not part of it');

    await writeFile(path.join(root, 'fixtures/coder-sum/test.js'), TEST_JS + '// weakened\n', 'utf8');
    assert.notEqual(await sha(), first, 'editing a fixture\'s test changes the corpus');
    await writeFile(path.join(root, 'fixtures/coder-sum/test.js'), TEST_JS, 'utf8');
    assert.equal(await sha(), first);
    assert.notEqual(await computeCorpusSha(root, [{ ...CODER, prompt: 'Fix it.' }]), first);

    const judged: GoldenTask = { ...CODER, verifiers: [{ kind: 'llm-judge', rubricFile: 'rubrics/r.md' }] };
    await mkdir(path.join(root, 'rubrics'));
    await writeFile(path.join(root, 'rubrics/r.md'), 'v1', 'utf8');
    const withRubric = await computeCorpusSha(root, [judged]);
    await writeFile(path.join(root, 'rubrics/r.md'), 'v2', 'utf8');
    assert.notEqual(await computeCorpusSha(root, [judged]), withRubric, 'a rubric is part of the corpus');
  });
});

test('a result records the corpus sha, attempts, adapter, model and who judged', async () => {
  await withCorpus([CODER], async (root) => {
    const judge = describeJudge({ adapter: 'stub', model: 'm' }, { adapter: 'stub', model: 'm' });
    const result = await new GoldenRunner({
      corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h', attempts: 3,
      adapter: 'stub', model: 'm', dispatch: async () => 'nothing',
      llmJudge: { verdict: async () => ({ passed: false, rationale: '' }), disclosure: judge },
    }).run();
    assert.equal(result.corpusSha, await computeCorpusSha(root, [CODER]));
    assert.deepEqual([result.attempts, result.adapter, result.model, result.judge],
      [3, 'stub', 'm', judge]);
    assert.equal(result.tasks[0]?.attempts.length, 3);
  });
});

test('a coder that rewrites its protected test fails even though the test now passes', async () => {
  await withCorpus([CODER], async (root) => {
    const result = await runner(root, async (_t, workDir) => {
      await writeFile(path.join(workDir, 'test.js'), 'process.exit(0);\n', 'utf8');
      return 'made the test pass';
    }).run();
    const outcomes = result.tasks[0]?.attempts[0]?.outcomes ?? [];
    assert.deepEqual(outcomes.map((o) => [o.kind, o.passed]), [['must-not-modify', false], ['test-script', true]],
      'the edited test passes, so only the protection check can catch this');
    assert.match(outcomes[0]?.detail ?? '', /protected file\(s\) modified: test\.js/);
    assert.deepEqual(result.solvedTaskIds, []);
  });
});

test('deleting or relinking a protected file fails too; an honest fix passes', async () => {
  await withCorpus([CODER], async (root) => {
    const verdict = async (dispatch: TaskDispatcher) => (await runner(root, dispatch).run()).solvedTaskIds;
    const fix = async (workDir: string) => writeFile(path.join(workDir, 'sum.js'), 'exports.sum = (a, b) => a + b;\n', 'utf8');
    assert.deepEqual(await verdict(async (_t, w) => { await fix(w); return 'fixed'; }), ['coder-sum']);
    assert.deepEqual(await verdict(async (_t, w) => { await fix(w); await unlink(path.join(w, 'test.js')); return 'x'; }), []);
    assert.deepEqual(await verdict(async (_t, w) => {
      await fix(w);
      await writeFile(path.join(w, 'copy.js'), TEST_JS, 'utf8');
      await unlink(path.join(w, 'test.js'));
      await symlink(path.join(w, 'copy.js'), path.join(w, 'test.js'));
      return 'same bytes behind a link';
    }), []);
  });
});

test('mustNotModify paths are validated like repoFixture', () => {
  assert.throws(() => assertGoldenCorpus([{ ...CODER, mustNotModify: ['../escape.js'] }]), /mustNotModify\[0\]/);
  assert.throws(() => assertGoldenCorpus([{ ...CODER, mustNotModify: ['/etc/passwd'] }]), /mustNotModify\[0\]/);
  assert.throws(() => assertGoldenCorpus([{ ...CODER, mustNotModify: 'test.js' }]), /must be an array/);
});

test('run(only) runs just the named task — a smoke check of task B does not run task A', async () => {
  await withCorpus([OTHER, CODER], async (root) => {
    const ran: string[] = [];
    const result = await runner(root, async (t) => { ran.push(t.id); if (t.id === 'coder-other') throw new Error('A is broken'); return 'ok'; })
      .run(['coder-sum']);
    assert.deepEqual(ran, ['coder-sum']);
    assert.deepEqual(result.tasks.map((t) => t.taskId), ['coder-sum']);
    assert.equal(result.tasks[0]?.attempts[0]?.error, undefined, 'the target ran cleanly; A\'s breakage is not its verdict');
    await assert.rejects(() => runner(root, async () => 'x').run(['nope']), /task\(s\) nope are not in the corpus/);
  });
});
