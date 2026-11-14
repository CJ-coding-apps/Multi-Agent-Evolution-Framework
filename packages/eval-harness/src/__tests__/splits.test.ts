import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CALIBRATION_RULE, GoldenRunner, HELD_OUT_RULE, SplitsError, computeSplitsSha, loadSplits,
  selectCalibrated,
} from '../index.js';
import type { CorpusSplits, GoldenTask } from '../index.js';

// ORACLE: D-57 — the train/held-out split is committed, named, and a partition of the corpus.

/** R4-A4: the pre-registration block every split file now carries. */
const PRE = { attempts: 'single' as const, selection: CALIBRATION_RULE, calibrationSha: null };

const task = (id: string): GoldenTask => ({
  id, repoFixture: `fixtures/${id}`, prompt: `do ${id}`, role: 'coder',
  verifiers: [{ kind: 'diff-match', mustContain: ['done'], mustNotContain: [] }],
  provenance: { source: 'human-decision', ref: 'split test fixture' },
});

// Eight tasks so a five-task held-out side can also leave a train set (R2-M2's floor).
const CORPUS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(task);
const IDS = CORPUS.map((t) => t.id);
const five = IDS.slice(0, 5);
const rest = IDS.slice(5);

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

test('splits: a valid partition loads, and its sha covers the lists and the floor', async () => {
  const splits: CorpusSplits = { version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: rest, heldOut: five };
  await withSplits(splits, async (root) => {
    const loaded = await loadSplits(root, CORPUS);
    assert.deepEqual(loaded.train, rest);
    assert.deepEqual(loaded.heldOut, five);
    assert.equal(loaded.minHeldOut, 5);
    assert.equal(loaded.sha, computeSplitsSha(splits));
    assert.match(loaded.sha, /^[0-9a-f]{64}$/);
  });
  // A different partition is a different yardstick, and so is a different declared floor.
  assert.notEqual(computeSplitsSha(splits), computeSplitsSha({ ...splits, train: ['a', 'b', 'c'], heldOut: ['d', 'e', 'f', 'g', 'h'] }));
  assert.notEqual(computeSplitsSha(splits), computeSplitsSha({ ...splits, minHeldOut: 6 }));

  // R3-G1: a pool is a third list, on neither side, and it is part of the yardstick's identity.
  const pooled: CorpusSplits = { version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['f', 'g'], heldOut: five, pool: ['h'] };
  await withSplits(pooled, async (root) => {
    const loaded = await loadSplits(root, CORPUS);
    assert.deepEqual(loaded.pool, ['h']);
    assert.equal(loaded.sha, computeSplitsSha(pooled));
  });
  assert.notEqual(computeSplitsSha(splits), computeSplitsSha(pooled));
  // Every other fixture in this file omits `pool`, so "no pool still loads" is exercised throughout.

  // R3-G3: the pre-registered test is part of the yardstick's identity too — a session that changed
  // alpha would be reporting a p-value nobody pre-registered, under the same split sha.
  assert.notEqual(computeSplitsSha(splits), computeSplitsSha({ ...splits, gate: { ...splits.gate, alpha: 0.1 } }));
});

test('splits: a gate resting on fewer than minHeldOut deterministic held-out tasks is refused (R2-M2)', async () => {
  // A judge-scored task does not count: it is a model's opinion, not a measurement.
  const judge = (id: string): GoldenTask => ({
    id, repoFixture: `fixtures/${id}`, prompt: `do ${id}`, role: 'reviewer',
    verifiers: [{ kind: 'llm-judge', rubricFile: 'rubrics/r.md' }],
    provenance: { source: 'human-decision', ref: 'split test fixture' },
  });
  const corpus = [...CORPUS, judge('j1'), judge('j2')];
  const file = { version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: [...rest, five[4]!], heldOut: [...five.slice(0, 4), 'j1', 'j2'] };
  await withSplits(file, async (root) => {
    await assert.rejects(() => loadSplits(root, corpus), (err: unknown) => {
      assert.ok(err instanceof SplitsError, String(err));
      assert.match(err.message, /4 deterministically scored tasks/);
      assert.match(err.message, /minHeldOut is 5/);
      assert.match(err.message, /j1, j2 are judge-scored and do not count/);
      return true;
    });
  });
  // The declared floor itself cannot be lowered below the constant, even if the corpus is large.
  await withSplits({ ...file, minHeldOut: 4, gate: HELD_OUT_RULE, heldOut: five }, async (root) => {
    await assert.rejects(() => loadSplits(root, corpus), /minHeldOut must be an integer of at least 5/);
  });
  await withSplits({ version: 1, train: rest, heldOut: five }, async (root) => {
    await assert.rejects(() => loadSplits(root, CORPUS), /minHeldOut must be an integer of at least 5/);
  });
  // And a split claiming more than it has is refused with the count it does have.
  await withSplits({ version: 1, minHeldOut: 6, gate: HELD_OUT_RULE, preRegistration: PRE, train: rest, heldOut: five }, async (root) => {
    await assert.rejects(() => loadSplits(root, CORPUS), /has 5 deterministically scored tasks/);
  });
});

test('splits: every way a split can fail to be a partition is refused', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [undefined, /no splits\.json/],
    ['{nope', /not readable JSON/],
    [{ version: 2, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a'], heldOut: ['b', 'c'] }, /version must be 1/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: 'a', heldOut: ['b', 'c'] }, /train must be an array/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'ghost'], heldOut: ['b', 'c'] }, /"ghost", which is not in the corpus/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'b', 'c'], heldOut: ['b'] }, /on both sides/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'a'], heldOut: ['b', 'c'] }, /more than once/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'b'], heldOut: ['c', 'd', 'e', 'f'] }, /g, h are in none of train, heldOut or pool/],
    // R3-G1: the pool is a third list, and it obeys the same partition rules.
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'b'], heldOut: ['c', 'd', 'e', 'f'], pool: ['g', 'g'] }, /pool names g more than once/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'b'], heldOut: ['c', 'd', 'e', 'f'], pool: ['a'] }, /on both sides of the split \(train and pool\)/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a', 'b'], heldOut: ['c', 'd', 'e', 'f'], pool: ['ghost'] }, /"ghost", which is not in the corpus/],
    [{ version: 1, minHeldOut: 1, gate: HELD_OUT_RULE, preRegistration: PRE, train: ['a'], heldOut: ['b'] }, /minHeldOut must be an integer of at least 5/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: PRE, train: [], heldOut: IDS }, /both sides need at least one task/],
    // R3-G3: the held-out test is pre-registered. A split that omits it, or names a different
    // alpha or run count, is refused before any harness runs.
    [{ version: 1, minHeldOut: 5, train: ['a'], heldOut: ['b', 'c'] }, /no "gate"\. D-57 fixes the held-out test before any run/],
    [{ version: 1, minHeldOut: 5, gate: { ...HELD_OUT_RULE, alpha: 0.1 }, preRegistration: PRE, train: ['a'], heldOut: ['b', 'c'] }, /alpha is 0\.1, the code implements 0\.05/],
    [{ version: 1, minHeldOut: 5, gate: { ...HELD_OUT_RULE, runs: 3 }, preRegistration: PRE, train: ['a'], heldOut: ['b', 'c'] }, /runs is 3, the code implements 10/],
    // R4-A4: the rest of the pre-registration — the unit, the selection rule, the measurement.
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, train: ['a'], heldOut: ['b', 'c'] }, /no "preRegistration"\. D-57 fixes the measurement before any run/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: { ...PRE, attempts: 'pass@2' }, train: ['a'], heldOut: ['b', 'c'] }, /attempts is "pass@2", the code implements "single"/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: { ...PRE, selection: 'keep everything' }, train: ['a'], heldOut: ['b', 'c'] }, /selection is not the selection rule this build implements/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: { ...PRE, calibrationSha: 'nope' }, train: ['a'], heldOut: ['b', 'c'] }, /must be null or a sha256 hex digest/],
    [{ version: 1, minHeldOut: 5, gate: HELD_OUT_RULE, preRegistration: { ...PRE, calibrationSha: 'a'.repeat(64) }, train: ['a'], heldOut: ['b', 'c'] }, /there is no calibration\.json/],
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

/** A calibration record whose counts select exactly `ids`, for a split that names it. */
function calibrationRecord(ids: readonly string[]): string {
  const counts = ids.map((taskId) => ({ taskId, passes: 1, attempts: 3 }));
  return `${JSON.stringify({
    version: 1, harnessId: 'split-test', harnessSha: 'a'.repeat(64), adapter: 'scripted', runs: 3,
    ranAt: '2026-11-13T00:00:00.000Z', splitsSha: 'split-test', rule: CALIBRATION_RULE,
    tasks: counts, errors: [], selection: selectCalibrated(counts),
  }, null, 2)}\n`;
}

test('splits: the calibration a split names is the one on disk, byte for byte (R4-A4)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-splits-cal-'));
  try {
    const calibration = calibrationRecord(five);
    const sha = createHash('sha256').update(calibration, 'utf8').digest('hex');
    const file: CorpusSplits = {
      version: 1, minHeldOut: 5, gate: HELD_OUT_RULE,
      preRegistration: { ...PRE, calibrationSha: sha }, train: rest, heldOut: five,
    };
    await writeFile(path.join(root, 'splits.json'), JSON.stringify(file), 'utf8');
    await writeFile(path.join(root, 'calibration.json'), calibration, 'utf8');
    const loaded = await loadSplits(root, CORPUS);
    assert.equal(loaded.preRegistration.calibrationSha, sha, 'the loaded split carries the measurement it names');
    // The measurement is part of the yardstick's identity, not an annotation on it.
    assert.notEqual(computeSplitsSha(file), computeSplitsSha({ ...file, preRegistration: PRE }));
    assert.notEqual(computeSplitsSha(file),
      computeSplitsSha({ ...file, preRegistration: { ...PRE, calibrationSha: 'b'.repeat(64) } }));
    // A different measurement behind the same split is refused: the yardstick would not be the one named.
    await writeFile(path.join(root, 'calibration.json'), '{"version":1,"note":"other"}\n', 'utf8');
    await assert.rejects(() => loadSplits(root, CORPUS),
      /does not come from the measurement the split names/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R5-P3 (round-4 finding R4-M1): `heldOut` is the selection the committed counts and rule produce.
// A hand-edited held-out set that the record does not derive is refused at load.
test('splits: a heldOut the calibration record does not derive is refused (R5-P3)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-splits-derived-'));
  try {
    const calibration = calibrationRecord(five);
    const sha = createHash('sha256').update(calibration, 'utf8').digest('hex');
    const handPicked: CorpusSplits = {
      version: 1, minHeldOut: 5, gate: HELD_OUT_RULE,
      // The record selects a, b, c, d, e; the split names a, b, c, d, f — one task swapped.
      preRegistration: { ...PRE, calibrationSha: sha }, train: ['e', 'g', 'h'],
      heldOut: ['a', 'b', 'c', 'd', 'f'],
    };
    await writeFile(path.join(root, 'splits.json'), JSON.stringify(handPicked), 'utf8');
    await writeFile(path.join(root, 'calibration.json'), calibration, 'utf8');
    await assert.rejects(() => loadSplits(root, CORPUS), (err: unknown) => {
      assert.ok(err instanceof SplitsError, `not a SplitsError: ${String(err)}`);
      assert.match(err.message, /heldOut is not the selection calibration\.json derives/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
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
