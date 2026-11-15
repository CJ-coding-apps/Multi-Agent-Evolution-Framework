import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GoldenRunner, HIDDEN_STORE_FILE, HIDDEN_STORE_VERSION, canaryToken, captureExpectations,
  encodeHidden, injectCanary,
} from '../index.js';
import type { GoldenTask, GoldenSuiteResult, RecordedSurface } from '../index.js';

// ORACLE (R6-H1): an attempt that reads hidden material is void. There is no sandbox yet, so the
// rule is detection plus cheap prevention: the checks are not plain files, they are decoded into a
// private directory only after the agent has stopped, and every hidden file carries a canary that
// a scan of the attempt's record and worktree looks for. The three shapes the verifier named are
// covered here: a read that reaches the run's own output (the `/proc/<pid>/cwd` script printing a
// check), a canary in a tool call's stdout, and a clean attempt that must be unaffected.

const execFileAsync = promisify(execFile);

const CHECK = "const assert = require('node:assert');\n"
  + "const { value } = require('./impl');\nassert.equal(value(), 42);\n";
const CHECK_REL = '.checks/check.js';

const TASK: GoldenTask = {
  id: 't-hidden',
  repoFixture: 'fixtures/hidden',
  prompt: 'make value() return the number the test expects',
  role: 'coder',
  verifiers: [{ kind: 'test-script', command: 'node', args: ['check.js'], expectExit: 0 }],
  hiddenChecks: [CHECK_REL],
  provenance: { source: 'human-decision', ref: 'contamination test fixture, 2026-11-14' },
};

async function withCorpus(fn: (root: string, canary: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-contamination-'));
  try {
    const repo = path.join(root, 'fixtures/hidden');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'impl.js'), 'exports.value = () => 0;\n', 'utf8');
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify([TASK]), 'utf8');
    // R7-H2: the expected values live beside the check, in the checker's half of the store.
    const captured = await captureExpectations(CHECK, repo);
    assert.equal(captured.failure, undefined);
    await writeFile(path.join(root, HIDDEN_STORE_FILE), JSON.stringify({
      version: HIDDEN_STORE_VERSION, encoding: 'gzip+base64',
      checks: { [TASK.id]: { [CHECK_REL]: encodeHidden(injectCanary(CHECK, TASK.id, CHECK_REL)) } },
      references: {},
      expectations: { [TASK.id]: { [CHECK_REL]: encodeHidden(JSON.stringify(captured.expectations)) } },
    }), 'utf8');
    await fn(root, canaryToken(TASK.id, CHECK_REL));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runner(
  root: string,
  dispatch: (workDir: string) => Promise<string>,
  surfaces?: (task: GoldenTask) => Promise<readonly RecordedSurface[]>,
): GoldenRunner {
  return new GoldenRunner({
    corpusRoot: root, harnessSha: 'd'.repeat(64), harnessId: 'h-contam', adapter: 'stub', attempts: 1,
    dispatch: (_task, workDir) => dispatch(workDir),
    ...(surfaces !== undefined ? { recordedSurfaces: surfaces } : {}),
  });
}

/** The fix a clean agent makes: the check then passes, so a void must not come from the verifier. */
async function fix(workDir: string): Promise<void> {
  await writeFile(path.join(workDir, 'impl.js'), 'exports.value = () => 42;\n', 'utf8');
}

function only(result: GoldenSuiteResult) {
  const attempt = result.tasks[0]?.attempts[0];
  assert.ok(attempt !== undefined);
  return attempt;
}

test('a check read into the run (the /proc/<pid>/cwd shape) voids the attempt', async () => {
  await withCorpus(async (root, canary) => {
    // What the verifier's script did: find the corpus through the process's cwd, read the check,
    // print it. Here the read's text reaches the final output, which is what the scan sees.
    const result = await runner(root, async (workDir) => {
      await fix(workDir);
      return `found it: // ${canary}\n${CHECK}`;
    }).run();
    const attempt = only(result);
    assert.equal(attempt.passed, false, 'a contaminated attempt is scored as a failure');
    assert.equal(attempt.contaminated?.evidence.length, 1);
    assert.match(attempt.contaminated?.evidence[0] ?? '', /the final assistant output/);
    assert.deepEqual(result.solvedTaskIds, []);
    assert.match(result.contamination?.statement ?? '', /cannot support an improvement claim/);
  });
});

test('a canary in a tool call\'s stdout voids the attempt', async () => {
  await withCorpus(async (root, canary) => {
    const surfaces = async (): Promise<RecordedSurface[]> => [
      { label: 'tool test.run stdout', text: `...${canary}...` },
    ];
    const result = await runner(root, async (workDir) => { await fix(workDir); return 'done'; }, surfaces).run();
    const attempt = only(result);
    assert.equal(attempt.passed, false);
    assert.match(attempt.contaminated?.evidence.join('\n') ?? '', /tool test\.run stdout/);
    assert.notEqual(result.contamination, undefined);
  });
});

test('the store\'s own name in the record voids the attempt', async () => {
  await withCorpus(async (root) => {
    const result = await runner(root, async (workDir) => {
      await fix(workDir);
      return `I read tests/goldens/${HIDDEN_STORE_FILE}`;
    }).run();
    assert.equal(only(result).passed, false);
    assert.match(only(result).contaminated?.evidence[0] ?? '', new RegExp(HIDDEN_STORE_FILE));
  });
});

test('a canary written into the final worktree voids the attempt', async () => {
  await withCorpus(async (root, canary) => {
    const result = await runner(root, async (workDir) => {
      await fix(workDir);
      await writeFile(path.join(workDir, 'notes.txt'), `remember ${canary}\n`, 'utf8');
      return 'done';
    }).run();
    const attempt = only(result);
    assert.equal(attempt.passed, false);
    assert.match(attempt.contaminated?.evidence.join('\n') ?? '', /the file notes\.txt/);
  });
});

test('a clean attempt is unaffected and its check still passes', async () => {
  await withCorpus(async (root, canary) => {
    const surfaces = async (): Promise<RecordedSurface[]> => [
      { label: 'tool fs.read stdout', text: 'impl.js: exports.value = () => 0;' },
      { label: 'transcript', text: 'the coder made value return 42' },
    ];
    const result = await runner(root, async (workDir) => { await fix(workDir); return 'returned 42'; }, surfaces).run();
    const attempt = only(result);
    assert.equal(attempt.contaminated, undefined);
    assert.equal(attempt.passed, true);
    assert.deepEqual(result.solvedTaskIds, ['t-hidden']);
    assert.equal(result.contamination, undefined);
    assert.ok(!JSON.stringify(result).includes(canary), 'a clean result records no canary');
  });
});
