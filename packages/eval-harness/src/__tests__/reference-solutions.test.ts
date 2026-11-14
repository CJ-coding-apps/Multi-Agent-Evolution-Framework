import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertGoldenCorpus, runVerifiers } from '../index.js';

// ORACLE (WP-3.7b R5-P2): every hidden-check task is proven both solvable and failing, offline.
// The unmodified fixture must fail the checks the runner copies in, and a shipped `.reference/`
// solution must pass them. Neither artifact is visible to the agent: `.checks/` is materialized
// only after the agent finishes, and `.reference/` never enters a run at all. A task whose check
// no verifier runs, whose reference is missing, or whose reference does not actually pass is a
// task that cannot be calibrated honestly, so it cannot be committed.

const CORPUS = path.resolve(__dirname, '../../../../tests/goldens');
const NEVER_IN_WORKTREE = new Set(['.checks', '.reference']);

interface Staged {
  dir: string;
  cleanup: () => Promise<void>;
}

/** A fixture copy as the agent sees it: everything but `.checks/` and `.reference/`. */
async function stage(fixtureDir: string, withReference: boolean): Promise<Staged> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-reference-'));
  await cp(fixtureDir, dir, {
    recursive: true,
    filter: (src) => !path.relative(fixtureDir, src).split(path.sep).some((seg) => NEVER_IN_WORKTREE.has(seg)),
  });
  if (withReference) await cp(path.join(fixtureDir, '.reference'), dir, { recursive: true });
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

/** Copy each hidden check to the path below `.checks/` where the task's verifier runs it. */
async function placeChecks(fixtureDir: string, dir: string, checks: readonly string[]): Promise<void> {
  for (const rel of checks) {
    const target = path.join(dir, rel.slice('.checks/'.length));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(fixtureDir, rel), target);
  }
}

test('every hidden-check task is proven solvable by its reference and failing without it', {
  timeout: 300_000,
}, async () => {
  const corpusJson: unknown = JSON.parse(await readFile(path.join(CORPUS, 'corpus.json'), 'utf8'));
  assertGoldenCorpus(corpusJson);
  const tasks = corpusJson.filter((t) => t.hiddenChecks !== undefined);
  assert.ok(tasks.length > 0, 'no hidden-check tasks found');

  const failures: string[] = [];
  for (const task of tasks) {
    const fixtureDir = path.resolve(CORPUS, task.repoFixture);
    const checks = task.hiddenChecks ?? [];
    // The checks are only scored if a verifier runs the file they are materialized as.
    const runnable = new Set(task.verifiers.flatMap((v) => (v.kind === 'test-script' ? v.args : [])));
    for (const rel of checks) {
      if (!runnable.has(rel.slice('.checks/'.length)))
        failures.push(`${task.id}: hidden check ${rel} is not run by any test-script verifier`);
    }
    const refEntries = await readdir(path.join(fixtureDir, '.reference')).catch(() => [] as string[]);
    if (refEntries.length === 0) {
      failures.push(`${task.id}: ships no reference solution under .reference/`);
      continue;
    }

    for (const withReference of [false, true]) {
      const staged = await stage(fixtureDir, withReference);
      try {
        await placeChecks(fixtureDir, staged.dir, checks);
        const outcomes = await runVerifiers(task.verifiers, {
          workDir: staged.dir, output: '', diff: '', corpusRoot: CORPUS,
        });
        const failed = outcomes.filter((o) => !o.passed);
        if (withReference && failed.length > 0)
          failures.push(`${task.id}: the reference fails ${failed.map((o) => o.detail).join('; ')}`);
        if (!withReference && failed.length !== outcomes.length)
          failures.push(`${task.id}: the unmodified fixture passes ${outcomes.filter((o) => o.passed).length}/${outcomes.length} verifiers`);
      } finally {
        await staged.cleanup();
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});
