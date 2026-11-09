import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GoldenRunner, SplitsError, computeSplitsSha, loadSplits } from '../index.js';
import type { CorpusSplits, GoldenTask } from '../index.js';

// ORACLE: D-57 — the train/held-out split is committed, named, and a partition of the corpus.

const task = (id: string): GoldenTask => ({
  id, repoFixture: `fixtures/${id}`, prompt: `do ${id}`, role: 'coder',
  verifiers: [{ kind: 'diff-match', mustContain: ['done'], mustNotContain: [] }],
  provenance: { source: 'human-decision', ref: 'split test fixture' },
});

const CORPUS = [task('a'), task('b'), task('c')];

async function withSplits(file: unknown, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-splits-'));
  try {
    if (file !== undefined)
      await writeFile(path.join(root, 'splits.json'),
        typeof file === 'string' ? file : JSON.stringify(file), 'utf8');
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('splits: a valid partition loads, and its sha covers the lists', async () => {
  const splits: CorpusSplits = { version: 1, train: ['a', 'b'], heldOut: ['c'] };
  await withSplits(splits, async (root) => {
    const loaded = await loadSplits(root, CORPUS);
    assert.deepEqual(loaded.train, ['a', 'b']);
    assert.deepEqual(loaded.heldOut, ['c']);
    assert.equal(loaded.sha, computeSplitsSha(splits));
    assert.match(loaded.sha, /^[0-9a-f]{64}$/);
  });
  // A different partition is a different yardstick.
  assert.notEqual(
    computeSplitsSha(splits),
    computeSplitsSha({ version: 1, train: ['a'], heldOut: ['b', 'c'] }),
  );
});

test('splits: every way a split can fail to be a partition is refused', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [undefined, /no splits\.json/],
    ['{nope', /not readable JSON/],
    [{ version: 2, train: ['a'], heldOut: ['b', 'c'] }, /version must be 1/],
    [{ version: 1, train: 'a', heldOut: ['b', 'c'] }, /train must be an array/],
    [{ version: 1, train: ['a', 'ghost'], heldOut: ['b', 'c'] }, /"ghost", which is not in the corpus/],
    [{ version: 1, train: ['a', 'b', 'c'], heldOut: ['b'] }, /on both sides/],
    [{ version: 1, train: ['a', 'a'], heldOut: ['b', 'c'] }, /more than once/],
    [{ version: 1, train: ['a'], heldOut: ['b'] }, /c is in neither split/],
    [{ version: 1, train: [], heldOut: ['a', 'b', 'c'] }, /both sides need at least one task/],
  ];
  for (const [file, re] of cases) {
    await withSplits(file, async (root) => {
      await assert.rejects(() => loadSplits(root, CORPUS), (err: unknown) => {
        assert.ok(err instanceof SplitsError, `not a SplitsError: ${String(err)}`);
        assert.match(err.message, re);
        return true;
      });
    });
  }
});

test('runner: a split-scoped runner stamps the split and refuses to run without its ids', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-splits-run-'));
  try {
    await mkdir(path.join(root, 'fixtures/t-hello'), { recursive: true });
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify([{
      id: 't-hello', repoFixture: 'fixtures/t-hello', prompt: 'x', role: 'coder',
      verifiers: [{ kind: 'diff-match', mustContain: ['done'], mustNotContain: [] }],
      provenance: { source: 'human-decision', ref: 'split test fixture' },
    }]), 'utf8');
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h', adapter: 'stub',
      attempts: 1,
      dispatch: async (_t, workDir: string) => {
        await writeFile(path.join(workDir, 'done.txt'), 'done', 'utf8');
        return 'wrote done';
      },
      split: { name: 'held-out', sha: 'b'.repeat(64) },
    });
    // D-57: the whole corpus under a split label would spend the yardstick on the evolver.
    await assert.rejects(() => runner.run(), /must be given the split's task ids/);
    const result = await runner.run(['t-hello']);
    assert.equal(result.split, 'held-out');
    assert.equal(result.splitsSha, 'b'.repeat(64));
    assert.equal(result.solvedTaskIds.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
