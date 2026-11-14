import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NEAR_COPY_THRESHOLD, encodeHidden, findHeldOutDuplicates, injectCanary, loadHiddenStore,
  readHiddenFile, withoutCanary,
} from '../index.js';
import type { GoldenTask } from '../index.js';

// R6-H2: the pool must not contain a copy of a train task. The committed corpus is clean; a planted
// copy is caught on each of the signals the guard checks, which is what makes a green CI run mean
// something.

const CORPUS = path.resolve(__dirname, '../../../../tests/goldens');

const loadCorpus = async (root: string): Promise<{
  corpus: GoldenTask[]; splits: { train: string[]; heldOut: string[]; pool: string[] };
}> => ({
  corpus: JSON.parse(await readFile(path.join(root, 'corpus.json'), 'utf8')) as GoldenTask[],
  splits: JSON.parse(await readFile(path.join(root, 'splits.json'), 'utf8')) as
    { train: string[]; heldOut: string[]; pool: string[] },
});

test('the committed corpus has no held-out task that duplicates a train task', async () => {
  const { corpus, splits } = await loadCorpus(CORPUS);
  const report = await findHeldOutDuplicates(CORPUS, corpus, splits);
  assert.deepEqual(report.findings, [], report.findings.map((f) => `${f.kind}: ${f.detail}`).join('\n'));
  assert.ok(report.maxSimilarity < NEAR_COPY_THRESHOLD,
    `the closest unrelated pair is ${report.maxSimilarity.toFixed(3)}, too close to the ${NEAR_COPY_THRESHOLD} floor`);
  assert.equal(report.heldOutTasks, splits.heldOut.length + (splits.pool ?? []).length);
  assert.equal(report.trainTasks, splits.train.length);
});

test('a planted copy is caught on every signal: bytes, normalized code, near-copy, hidden material', {
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-duplicates-'));
  try {
    await cp(CORPUS, root, { recursive: true });
    const { corpus, splits } = await loadCorpus(root);
    const read = (rel: string): Promise<string> => readFile(path.join(root, rel), 'utf8');

    // 1. Bytes: a pool fixture becomes the train fixture it copied.
    const sum = await read('fixtures/coder-sum/sum.js');
    await writeFile(path.join(root, 'fixtures/pool-roman/roman.js'), sum);

    // 2. Normalized: the same train file re-indented with a comment — a different hash, the same
    //    code once comments and whitespace are gone.
    const bitset = await read('fixtures/train-bitset/bitset.js');
    await writeFile(
      path.join(root, 'fixtures/pool-caesar-wrap/caesar.js'),
      `// reformatted copy\n${bitset.split('\n').join('\n    ')}\n`,
    );

    // 3. Near-copy: the train file with one extra line, so neither hash matches and only the token
    //    similarity remains.
    await writeFile(path.join(root, 'fixtures/pool-gcd-lcm/lcm.js'), `${bitset}\nconst extra = 1;\n`);

    // 4. Hidden material: a train task that today has none is given a pool task's reference,
    //    re-caned for itself. Two identical references must be caught however different their
    //    canaries are.
    const store = await loadHiddenStore(root);
    const stolen = withoutCanary(readHiddenFile(store, 'references', 'pool-lru', '.reference/lru.js'));
    store.references['coder-sum'] = {
      '.reference/sum.js': encodeHidden(injectCanary(stolen, 'coder-sum', '.reference/sum.js')),
    };
    await writeFile(path.join(root, 'hidden-store.json'), `${JSON.stringify(store, null, 2)}\n`);

    const report = await findHeldOutDuplicates(root, corpus, splits);
    const has = (kind: string, heldOut: string, train: string): boolean =>
      report.findings.some((f) => f.kind === kind && f.heldOut === heldOut && f.train === train);
    assert.ok(has('file', 'pool-roman', 'coder-sum'), 'byte-identical copy not caught');
    assert.ok(has('normalized', 'pool-caesar-wrap', 'train-bitset'), 'normalized copy not caught');
    assert.ok(has('near-copy', 'pool-gcd-lcm', 'train-bitset'), 'near-copy not caught');
    assert.ok(has('hidden-reference', 'pool-lru', 'coder-sum'), 'shared reference not caught');
    for (const finding of report.findings)
      assert.ok(!splits.train.includes(finding.heldOut), `${finding.heldOut} is a train task`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
