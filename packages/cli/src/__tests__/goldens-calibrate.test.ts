import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { LcmEngine } from '@maf/lcm';
import { CALIBRATION_MIN_SELECTED, loadSplits } from '@maf/eval-harness';
import type { GoldenSuiteResult, GoldenTask } from '@maf/eval-harness';
import { calibrationTaskIds, runCalibration } from '../commands/goldens.js';

// ORACLE: D-57 / R3-G2 — `goldens calibrate` measures the base harness on the pool in isolation,
// writes the counts with the rule it applied, and moves only the tasks that qualify into heldOut.
// The paid run (`--adapter claude`) is CJ's; everything here is the scripted adapter or an injected
// result, and no test spends money.

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, '../../../..');
const MAIN = path.resolve(__dirname, '../main.js');
const SEED = path.join(REPO, 'tests/goldens');

function lcmLoads(): boolean {
  try {
    new LcmEngine({ dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward', summarize: async () => '' }).close();
    return true;
  } catch {
    return false;
  }
}
const needsLcm = {
  skip: lcmLoads() || process.env['CI'] ? false : 'better-sqlite3 does not load on this host (CI runs this)',
  timeout: 240_000,
};

async function freshClone(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-calibrate-'));
  await mkdir(path.join(root, '.maf/harnesses'), { recursive: true });
  for (const entry of ['policy.yaml', 'roles.yaml', 'prompts']) {
    await cp(path.join(REPO, '.maf', entry), path.join(root, '.maf', entry), { recursive: true });
  }
  const harnesses = path.join(REPO, '.maf/harnesses');
  const name = (await readdir(harnesses)).find((n) => /^default-[0-9a-f]{64}\.json$/.test(n));
  assert.ok(name, 'the checkout commits a default harness');
  await cp(path.join(harnesses, name), path.join(root, '.maf/harnesses', name));
  await cp(SEED, path.join(root, 'tests/goldens'), { recursive: true });
  return root;
}

function run(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [MAIN, 'goldens', ...args], { cwd: root }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }),
  );
}

test('calibrate measures the whole pool 3 times with the scripted adapter and reports without selecting', needsLcm, async () => {
  const root = await freshClone();
  try {
    const splitsBefore = await readFile(path.join(root, 'tests/goldens/splits.json'), 'utf8');
    const { code, stdout, stderr } = await run(root, ['calibrate', '--adapter', 'scripted', '--corpus', 'tests/goldens']);
    // Every committed pool script is a plausible but wrong fix, so the base never passes one: no
    // task has headroom and the run reports and stops instead of writing a yardstick.
    assert.equal(code, 1, `calibration with nothing qualifying exits 1: ${stdout}${stderr}`);
    assert.match(stdout, /20 pool tasks × 3 runs/);
    assert.match(stdout, /20 never solved in 3, 0 solved every run \(no headroom\), 0 partial/);
    assert.match(stderr, /nothing was selected — only 0 tasks qualified/);
    assert.equal(await readFile(path.join(root, 'tests/goldens/splits.json'), 'utf8'), splitsBefore,
      'splits.json is untouched when nothing qualifies');

    const record = JSON.parse(await readFile(path.join(root, 'tests/goldens/calibration.json'), 'utf8')) as {
      version: number; runs: number; ranAt: string; rule: string; harnessSha: string;
      tasks: { taskId: string; passes: number; attempts: number }[];
      selection: { selected: string[]; qualified: boolean };
    };
    assert.equal(record.version, 1);
    assert.equal(record.runs, 3);
    assert.match(record.ranAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.tasks.length, 20);
    for (const t of record.tasks) {
      assert.equal(t.attempts, 3);
      assert.equal(t.passes, 0);
    }
    assert.match(record.rule, /0, 1 or 2 of 3/);
    assert.deepEqual(record.selection.selected, []);
    assert.equal(record.selection.qualified, false);
    // The calibration is not a gate baseline: it wrote no result and recorded no score.
    assert.ok(!(await readdir(path.join(root, '.maf'))).includes('goldens'));
    // And it never writes into the repository's corpus — only the clone's copy.
    assert.ok(!(await readdir(SEED)).includes('calibration.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('calibrate refuses a run count the rule was not pre-registered for, before running anything', async () => {
  const root = await freshClone();
  try {
    const { code, stdout, stderr } = await run(root, ['calibrate', '--adapter', 'scripted', '--corpus', 'tests/goldens', '--runs', '2']);
    assert.equal(code, 2, `--runs 2 stops with a refusal: ${stdout}${stderr}`);
    assert.match(stderr, /--runs "2" is not 3/);
    assert.match(stderr, /pre-registered for 3 base runs per task; nothing was run/);
    await assert.rejects(() => readFile(path.join(root, 'tests/goldens/calibration.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── the selection and the split rewrite, with an injected result ─────────────────────────────

const task = (id: string): GoldenTask => ({
  id, repoFixture: `fixtures/${id}`, prompt: `do ${id}`, role: 'coder',
  verifiers: [{ kind: 'diff-match', mustContain: ['done'], mustNotContain: [] }],
  provenance: { source: 'human-decision', ref: 'calibration test' },
});

const HELD_OUT = ['h1', 'h2', 'h3', 'h4', 'h5'];
const POOL = Array.from({ length: 12 }, (_, i) => `p${i}`);
const CORPUS = [...HELD_OUT, 'train-1', ...POOL].map(task);

/** A base result in which `passes` of the three attempts pass, for the listed tasks. */
function suite(counts: Array<[string, number]>, ranAt = '2026-11-12T00:00:00.000Z'): GoldenSuiteResult {
  return {
    harnessSha: 'a'.repeat(64), harnessId: 'base', corpusSha: 'c'.repeat(64), attempts: 3, adapter: 'stub',
    tasks: counts.map(([taskId, passes]) => ({
      taskId, role: 'coder', passed: passes > 0,
      attempts: [0, 1, 2].map((i) => ({ attempt: i, output: '', outcomes: [], passed: i < passes })),
    })),
    solvedTaskIds: counts.filter(([, p]) => p > 0).map(([id]) => id),
    ranAt,
  };
}

async function corpusRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-calibrate-corpus-'));
  await writeFile(path.join(root, 'corpus.json'), JSON.stringify(CORPUS, null, 2), 'utf8');
  await writeFile(path.join(root, 'splits.json'), JSON.stringify({
    version: 1, minHeldOut: 5, train: ['train-1'], heldOut: HELD_OUT, pool: POOL,
  }, null, 2), 'utf8');
  return root;
}

test('a qualified calibration writes the counts and moves the selected pool tasks into heldOut', async () => {
  const root = await corpusRoot();
  try {
    const splits = await loadSplits(root, CORPUS);
    // 10 partial and 2 never-solved: the cap allows floor(10/2) = 5, so both zeros are kept.
    const counts: Array<[string, number]> = [
      ...POOL.slice(0, 10).map((id, i): [string, number] => [id, i % 2 === 0 ? 1 : 2]),
      [POOL[10] as string, 0], [POOL[11] as string, 0],
    ];
    const out = await runCalibration({
      corpusRoot: root, splits, taskIds: POOL, harness: { id: 'base', sha: 'a'.repeat(64) },
      adapter: { name: 'stub' }, execute: async () => suite(counts),
    });
    assert.equal(out.selection.qualified, true);
    assert.deepEqual(out.selection.selected, POOL, 'every pool task qualifies, in pool order');
    assert.ok(out.splitsPath, 'the split was rewritten');

    const record = JSON.parse(await readFile(out.path, 'utf8')) as {
      splitsSha: string; harnessSha: string; tasks: { taskId: string; passes: number }[];
      errors: unknown[]; selection: { selected: string[] };
    };
    assert.equal(record.splitsSha, splits.sha, 'the record says which split it was decided against');
    assert.equal(record.harnessSha, 'a'.repeat(64));
    assert.equal(record.tasks.length, 12);
    assert.deepEqual(record.errors, []);
    assert.deepEqual(record.selection.selected, POOL);

    const next = await loadSplits(root, CORPUS);
    assert.deepEqual(next.heldOut, [...HELD_OUT, ...POOL]);
    assert.deepEqual(next.pool, []);
    assert.deepEqual(next.train, ['train-1']);
    assert.notEqual(next.sha, splits.sha, 'the yardstick changed identity when the held-out set grew');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a calibration below the floor writes its measurement and leaves splits.json byte-identical', async () => {
  const root = await corpusRoot();
  try {
    const splits = await loadSplits(root, CORPUS);
    const before = await readFile(path.join(root, 'splits.json'), 'utf8');
    const counts: Array<[string, number]> = [
      ...POOL.slice(0, CALIBRATION_MIN_SELECTED - 1).map((id): [string, number] => [id, 1]),
      ...POOL.slice(CALIBRATION_MIN_SELECTED - 1).map((id): [string, number] => [id, 3]),
    ];
    const out = await runCalibration({
      corpusRoot: root, splits, taskIds: POOL, harness: { id: 'base', sha: 'a'.repeat(64) },
      adapter: { name: 'stub' }, execute: async () => suite(counts),
    });
    assert.equal(out.selection.qualified, false);
    assert.equal(out.splitsPath, undefined);
    assert.match(out.selection.reason ?? '', new RegExp(`only ${CALIBRATION_MIN_SELECTED - 1} tasks qualified`));
    assert.equal(await readFile(path.join(root, 'splits.json'), 'utf8'), before);
    const record = JSON.parse(await readFile(out.path, 'utf8')) as { selection: { droppedAlwaysSolved: string[] } };
    assert.equal(record.selection.droppedAlwaysSolved.length, POOL.length - (CALIBRATION_MIN_SELECTED - 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a crashed attempt vetoes the selection: an infrastructure failure is not a measurement', async () => {
  const root = await corpusRoot();
  try {
    const splits = await loadSplits(root, CORPUS);
    const before = await readFile(path.join(root, 'splits.json'), 'utf8');
    // Enough partial tasks to qualify — but one attempt never ran, so nothing may be selected.
    const result = suite(POOL.map((id): [string, number] => [id, 1]));
    result.tasks[0]!.attempts[2] = {
      attempt: 2, output: '', outcomes: [], passed: false, error: 'the adapter exited 1',
    };
    const out = await runCalibration({
      corpusRoot: root, splits, taskIds: POOL, harness: { id: 'base', sha: 'a'.repeat(64) },
      adapter: { name: 'stub' }, execute: async () => result,
    });
    assert.equal(out.selection.qualified, false);
    assert.equal(out.splitsPath, undefined);
    assert.match(out.selection.reason ?? '', /1 attempt ended in an error \(p0\); a crashed attempt is not a measurement/);
    assert.deepEqual(out.record.errors, [{ taskId: 'p0', attempt: 2, error: 'the adapter exited 1' }]);
    assert.equal(await readFile(path.join(root, 'splits.json'), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--tasks accepts the pool or pool ids only: a train or held-out task cannot be calibrated', async () => {
  const root = await corpusRoot();
  try {
    const splits = await loadSplits(root, CORPUS);
    assert.deepEqual(calibrationTaskIds('pool', splits), POOL);
    assert.deepEqual(calibrationTaskIds('', splits), POOL);
    assert.deepEqual(calibrationTaskIds('p1, p3,p1', splits), ['p1', 'p3']);
    assert.throws(() => calibrationTaskIds('train-1', splits), /train-1 is not in the pool/);
    assert.throws(() => calibrationTaskIds('h1,p0', splits), /h1 is not in the pool/);
    const empty = { ...splits, pool: [] };
    assert.throws(() => calibrationTaskIds('pool', empty), /the split has no pool/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
