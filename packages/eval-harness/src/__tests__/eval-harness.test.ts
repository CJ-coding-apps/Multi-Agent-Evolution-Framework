import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GoldenRunner, GoldenCorpusError, assertGoldenCorpus, seesawDecision, runVerifier,
} from '../index.js';
import type { GoldenTask, GoldenSuiteResult, VerifierContext } from '../index.js';

// ORACLE: HARNESSX_INTEGRATION_PLAN.md §5.3 (Phase 2 tests) and §10.4 (provenance required).

const execFileAsync = promisify(execFile);

const TASK: GoldenTask = {
  id: 't-hello',
  repoFixture: 'fixtures/hello',
  prompt: 'say where the marker is',
  role: 'analyst',
  verifiers: [{ kind: 'diff-match', mustContain: ['done'], mustNotContain: ['forbidden-word'] }],
  provenance: { source: 'human-decision', ref: 'test fixture, 2026-09-09' },
};

async function withCorpus(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-corpus-'));
  try {
    await mkdir(path.join(root, 'fixtures/hello'), { recursive: true });
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify([TASK]), 'utf8');
    // Fixture repo: a git repo so diff-match sees the change
    const repo = path.join(root, 'fixtures/hello');
    await writeFile(path.join(repo, 'hello.txt'), 'hello', 'utf8');
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const passDispatch = async (_t: GoldenTask, workDir: string) => {
  await writeFile(path.join(workDir, 'done.txt'), 'done', 'utf8');
  return 'wrote done';
};

// ─── schema ────────────────────────────────────────────────────────────────

test('corpus schema: missing provenance is rejected', () => {
  const bad = [{ ...TASK, provenance: undefined }];
  assert.throws(() => assertGoldenCorpus(bad), /provenance is REQUIRED/);
});

test('corpus schema: unknown verifier kind and duplicate ids rejected', () => {
  assert.throws(
    () => assertGoldenCorpus([{ ...TASK, verifiers: [{ kind: 'magic' }] }]),
    GoldenCorpusError,
  );
  assert.throws(() => assertGoldenCorpus([TASK, TASK]), /duplicate task id/);
});

// ─── runner (stub dispatcher = deterministic shell) ────────────────────────

test('runner: pass@2, determinism across runs, verifier details recorded', async () => {
  await withCorpus(async (root) => {
    const mk = () => new GoldenRunner({
      corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h1',
      attempts: 2, dispatch: passDispatch,
    });
    const r1 = await mk().run();
    const r2 = await mk().run();
    assert.deepEqual(r1.solvedTaskIds, ['t-hello']);
    assert.deepEqual(r1.solvedTaskIds, r2.solvedTaskIds, 'same corpus+harness ⇒ same verdicts');
    assert.equal(r1.tasks[0]?.attempts.length, 2);
    assert.equal(r1.tasks[0]?.attempts[0]?.outcomes[0]?.kind, 'diff-match');
  });
});

test('runner: failing dispatcher marks task failed without crashing the suite', async () => {
  await withCorpus(async (root) => {
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'b'.repeat(64), harnessId: 'h2',
      attempts: 2, dispatch: async () => { throw new Error('boom'); },
    });
    const r = await runner.run();
    assert.deepEqual(r.solvedTaskIds, []);
    assert.match(r.tasks[0]?.attempts[0]?.error ?? '', /boom/);
  });
});

test('runner: isolation — fixture copies get fresh working dirs per attempt', async () => {
  await withCorpus(async (root) => {
    const seen: string[] = [];
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'c'.repeat(64), harnessId: 'h3', attempts: 2,
      dispatch: async (_t, workDir) => { seen.push(workDir); return 'x'; },
    });
    await runner.run();
    assert.equal(new Set(seen).size, 2, 'each attempt gets its own directory');
  });
});

// ─── seesaw (pure) ─────────────────────────────────────────────────────────

function suite(solved: string[]): GoldenSuiteResult {
  return { harnessSha: 'x'.repeat(64), harnessId: 'h', tasks: [], solvedTaskIds: solved, ranAt: 't' };
}

test('seesaw: ship requires improvement with no regressions', () => {
  assert.deepEqual(seesawDecision(suite(['a', 'b']), suite(['a', 'b', 'c'])),
    { kind: 'ship', improvements: ['c'] });
});

test('seesaw: any regression rejects even with other improvements', () => {
  const d = seesawDecision(suite(['a', 'b']), suite(['a', 'c']));
  assert.equal(d.kind, 'reject');
  assert.deepEqual((d as { regressions: string[] }).regressions, ['b']);
});

test('seesaw: identical score sets are no-change (not ship)', () => {
  assert.deepEqual(seesawDecision(suite(['a']), suite(['a'])), { kind: 'no-change' });
});

test('M4: llm-judge verifier uses the injected judge; fails closed when unwired', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-judge-'));
  await mkdir(path.join(root, 'rubrics'), { recursive: true });
  await writeFile(path.join(root, 'rubrics', 'r.md'), 'Must mention SQL injection.', 'utf8');

  const judged: string[] = [];
  const withJudge: VerifierContext = {
    workDir: root, output: 'The code is vulnerable to SQL injection.', diff: '', corpusRoot: root,
    llmJudge: async (rubric, subject) => {
      judged.push(subject);
      return { passed: rubric.includes('SQL') && subject.includes('SQL injection'), rationale: 'ok' };
    },
  };
  const pass = await runVerifier({ kind: 'llm-judge', rubricFile: 'rubrics/r.md' }, withJudge);
  assert.equal(pass.passed, true);
  assert.equal(judged.length, 1, 'the wired judge was actually invoked');

  const noJudge: VerifierContext = { workDir: root, output: 'x', diff: '', corpusRoot: root };
  const fail = await runVerifier({ kind: 'llm-judge', rubricFile: 'rubrics/r.md' }, noJudge);
  assert.equal(fail.passed, false, 'no judge wired → fail closed, never silent pass');

  await rm(root, { recursive: true, force: true });
});
