import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertGoldenCorpus, compareObservations, expectationPaths, hiddenPaths, loadHiddenStore,
  readExpectations, readHiddenFile, runHiddenCheck,
} from '../index.js';

// ORACLE (WP-3.7b R5-P2, R6-H1, R7-H2): every hidden-check task is proven both solvable and
// failing, offline, through the same process boundary a run faces. The unmodified fixture must
// fail the check, and the task's stored reference solution must produce exactly the observations
// the checker holds as expectations. Neither artifact is a plain file the agent can read: both live
// in the encoded hidden store, and the expectations never leave the checker process at all. A task
// whose check no verifier runs, whose reference is missing, or whose reference does not actually
// pass is a task that cannot be calibrated honestly, so it cannot be committed.

const CORPUS = path.resolve(__dirname, '../../../../tests/goldens');
const NEVER_IN_WORKTREE = new Set(['.checks', '.reference']);

interface Staged {
  dir: string;
  cleanup: () => Promise<void>;
}

/** A fixture copy as the agent sees it: no hidden directory exists in the fixture at all. */
async function stage(fixtureDir: string): Promise<Staged> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-reference-'));
  await cp(fixtureDir, dir, {
    recursive: true,
    filter: (src) => !path.relative(fixtureDir, src).split(path.sep).some((seg) => NEVER_IN_WORKTREE.has(seg)),
  });
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

/** Write stored files at their path below their hidden directory (`dir` is the fixture root). */
async function place(
  store: Awaited<ReturnType<typeof loadHiddenStore>>, section: 'checks' | 'references',
  taskId: string, dir: string,
): Promise<void> {
  for (const rel of hiddenPaths(store, section, taskId)) {
    const target = path.join(dir, rel.slice(`.${section === 'checks' ? 'checks' : 'reference'}/`.length));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, readHiddenFile(store, section, taskId, rel), 'utf8');
  }
}

test('every hidden-check task is proven solvable by its reference and failing without it', {
  timeout: 300_000,
}, async () => {
  const corpusJson: unknown = JSON.parse(await readFile(path.join(CORPUS, 'corpus.json'), 'utf8'));
  assertGoldenCorpus(corpusJson);
  const store = await loadHiddenStore(CORPUS);
  const tasks = corpusJson.filter((t) => t.hiddenChecks !== undefined);
  assert.ok(tasks.length > 0, 'no hidden-check tasks found');
  const first = tasks[0];
  assert.ok(first !== undefined && expectationPaths(store, first.id).length > 0, 'the store holds no expectations');

  const failures: string[] = [];
  // R6-H1: the store replaced the plaintext directories, and a fixture that still carries one is
  // readable by the agent's own code — the verifier demonstrated exactly that read.
  for (const fixture of await readdir(path.join(CORPUS, 'fixtures'), { withFileTypes: true })) {
    if (!fixture.isDirectory()) continue;
    for (const seg of NEVER_IN_WORKTREE) {
      const leftover = await readdir(path.join(CORPUS, 'fixtures', fixture.name, seg)).catch(() => undefined);
      if (leftover !== undefined)
        failures.push(`${fixture.name}: still ships a plaintext ${seg}/ directory; hidden files live in the encoded store`);
    }
  }
  for (const task of tasks) {
    const fixtureDir = path.resolve(CORPUS, task.repoFixture);
    const checks = task.hiddenChecks ?? [];
    // The checks are only scored if a verifier runs the file they are stored as.
    const runnable = new Set(task.verifiers.flatMap((v) => (v.kind === 'test-script' ? v.args : [])));
    for (const rel of checks) {
      if (!runnable.has(rel.slice('.checks/'.length)))
        failures.push(`${task.id}: hidden check ${rel} is not run by any test-script verifier`);
    }
    if (hiddenPaths(store, 'references', task.id).length === 0) {
      failures.push(`${task.id}: ships no reference solution in the hidden store`);
      continue;
    }
    const rel = checks[0];
    if (rel === undefined) continue;
    const checkSource = readHiddenFile(store, 'checks', task.id, rel);
    let expectations;
    try {
      expectations = readExpectations(store, task.id, rel);
    } catch (err) {
      failures.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (expectations.length === 0) {
      failures.push(`${task.id}: the check holds no expectations, so it cannot judge a run`);
      continue;
    }

    for (const withReference of [false, true]) {
      const staged = await stage(fixtureDir);
      try {
        if (withReference) await place(store, 'references', task.id, staged.dir);
        // R7-H2: the check runs in a child process; the expected values never leave this one.
        const run = await runHiddenCheck(checkSource, staged.dir);
        if (run.failure !== undefined) {
          // A check that stops is a failed run: an unsolved fixture is expected to make it throw.
          // A reference that cannot finish its own check is a task defect.
          if (withReference)
            failures.push(`${task.id}: the reference does not finish the check: ${run.failure}`);
          else if (run.failure.startsWith('the check driver'))
            failures.push(`${task.id}: the unmodified fixture stopped the driver: ${run.failure}`);
          continue;
        }
        const verdict = compareObservations(run.observations, expectations);
        if (withReference && !verdict.passed)
          failures.push(`${task.id}: the reference fails its own check: ${verdict.detail}`);
        if (!withReference && verdict.passed)
          failures.push(`${task.id}: the unmodified fixture passes the check`);
      } finally {
        await staged.cleanup();
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});
