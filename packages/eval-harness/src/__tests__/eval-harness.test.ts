import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GoldenRunner, GoldenCorpusError, assertGoldenCorpus, seesawDecision, runVerifier,
  encodeHidden, injectCanary, HIDDEN_STORE_FILE, HIDDEN_STORE_VERSION,
} from '../index.js';
import type { GoldenTask, GoldenSuiteResult, VerifierContext } from '../index.js';

// ORACLE: golden-run outcome reporting, and GoldenTask's required provenance.

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
      corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h1', adapter: 'stub',
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
      corpusRoot: root, harnessSha: 'b'.repeat(64), harnessId: 'h2', adapter: 'stub',
      attempts: 2, dispatch: async () => { throw new Error('boom'); },
    });
    const r = await runner.run();
    assert.deepEqual(r.solvedTaskIds, []);
    assert.match(r.tasks[0]?.attempts[0]?.error ?? '', /boom/);
  });
});

// R5-P1 / R6-H1: the pool's acceptance checks must never reach the worktree the agent edits — a
// visible test is what made the pool too easy — and they are not plain files in the fixture either.
// This test watches both halves: the fixture tree holds no `.checks/`, the dispatcher sees neither
// `.checks/` nor the check file, and the `test-script` verifier still finds and passes the check
// decoded from the store. Without the second half every pool task would be silently unsolvable,
// which the scripted baseline cannot notice — its pool tasks fail by design, with or without a
// check to fail against.
test('runner: a hidden check is absent from the agent worktree and runs for scoring (R5-P1)', async () => {
  await withCorpus(async (root) => {
    const repo = path.join(root, 'fixtures/hello');
    const task: GoldenTask = {
      ...TASK,
      hiddenChecks: ['.checks/check.js'],
      verifiers: [{ kind: 'test-script', command: 'node', args: ['check.js'], expectExit: 0 }],
    };
    const check = "const assert = require('node:assert');\nconst { value } = require('./impl');\nassert.equal(value(), 42);\n";
    await writeFile(path.join(root, HIDDEN_STORE_FILE), JSON.stringify({
      version: HIDDEN_STORE_VERSION, encoding: 'gzip+base64',
      checks: { [task.id]: { '.checks/check.js': encodeHidden(injectCanary(check, task.id, '.checks/check.js')) } },
      references: {},
      // R7-H2: the checker's half — the expected value never travels with the check.
      expectations: {
        [task.id]: { '.checks/check.js': encodeHidden(JSON.stringify([{ op: 'equal', loose: true, e: 42 }])) },
      },
    }), 'utf8');
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify([task]), 'utf8');

    const seen: string[] = [];
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'c'.repeat(64), harnessId: 'h3', adapter: 'stub', attempts: 1,
      dispatch: async (_t, workDir) => {
        for (const name of ['.checks', 'check.js']) {
          try {
            await access(path.join(workDir, name));
            seen.push(name);
          } catch { /* absent, as it must be */ }
        }
        await writeFile(path.join(workDir, 'impl.js'), 'exports.value = () => 42;\n', 'utf8');
        return 'wrote impl';
      },
    });
    const r = await runner.run();
    assert.deepEqual(seen, [], 'the worktree the agent edits holds no check');
    assert.deepEqual(r.solvedTaskIds, ['t-hello'], 'the scorer materialized the check and it passed');
    assert.equal(r.tasks[0]?.attempts[0]?.outcomes[0]?.passed, true);
  });
});

test('runner: isolation — fixture copies get fresh working dirs per attempt', async () => {
  await withCorpus(async (root) => {
    const seen: string[] = [];
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'c'.repeat(64), harnessId: 'h3', adapter: 'stub', attempts: 2,
      dispatch: async (_t, workDir) => { seen.push(workDir); return 'x'; },
    });
    await runner.run();
    assert.equal(new Set(seen).size, 2, 'each attempt gets its own directory');
  });
});

// R6-M1: the ceiling used to be asked only before a suite, so one 59-task run could cross a
// 1.5M-token budget at 3.05M and nothing inside the run ever looked again. It is asked after
// every task now: the suite stops after the task that crossed it, the result says it is partial,
// and the tasks it never started are not paid for.
test('runner: a crossed limit stops inside the suite and the result says how far it got (R6-M1)', async () => {
  await withCorpus(async (root) => {
    const tasks: GoldenTask[] = ['a', 'b', 'c', 'd'].map((s) => ({ ...TASK, id: `t-${s}` }));
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify(tasks), 'utf8');

    let asked = 0;
    let dispatched = 0;
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'e'.repeat(64), harnessId: 'h5', adapter: 'stub', attempts: 1,
      dispatch: async (_t, workDir) => { dispatched++; return passDispatch(_t, workDir); },
      // The first ask (after task 1) is inside the ceiling; the second (after task 2) is not.
      limit: {
        crossed: () => (++asked >= 2 ? 'budget exhausted (tokens): spent 1 of 1 tokens' : undefined),
      },
    });
    const r = await runner.run();
    assert.equal(dispatched, 2, 'the third task was never started');
    assert.equal(r.tasks.length, 2);
    assert.deepEqual(r.solvedTaskIds, ['t-a', 't-b'], 'what ran is still scored');
    assert.equal(r.partial?.completedTasks, 2);
    assert.equal(r.partial?.totalTasks, 4, 'the ceiling is measured against the whole suite');
    assert.equal(
      r.partial?.statement,
      '2 of 4 tasks ran before the budget was crossed (budget exhausted (tokens): spent 1 of 1 tokens); ' +
      'the rest of the suite was not started and this result is partial.',
    );
  });
});

// The overshoot is the task that crossed the ceiling, not the one after it: a limit crossed by the
// final task leaves a whole result, because there is no rest of the suite to skip.
test('runner: a limit crossed by the final task leaves a whole result (R6-M1)', async () => {
  await withCorpus(async (root) => {
    const tasks: GoldenTask[] = ['a', 'b'].map((s) => ({ ...TASK, id: `t-${s}` }));
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify(tasks), 'utf8');

    let asked = 0;
    const r = await new GoldenRunner({
      corpusRoot: root, harnessSha: 'f'.repeat(64), harnessId: 'h6', adapter: 'stub', attempts: 1,
      dispatch: passDispatch,
      limit: { crossed: () => (++asked >= 2 ? 'budget exhausted (tokens): spent 1 of 1 tokens' : undefined) },
    }).run();
    assert.equal(r.tasks.length, 2, 'both tasks ran');
    assert.equal(r.partial, undefined, 'nothing was skipped, so the result is not partial');
  });
});

// ─── seesaw (pure) ─────────────────────────────────────────────────────────

function suite(solved: string[]): GoldenSuiteResult {
  return { harnessSha: 'x'.repeat(64), harnessId: 'h', adapter: 'stub', tasks: [], solvedTaskIds: solved, ranAt: 't' };
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
