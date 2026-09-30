import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GoldenRunner } from '../index.js';
import type { GoldenTask } from '../index.js';

// ORACLE: IMPLEMENTATION_CHECKLIST_2026-09-25.md A4 — a fixture is plain tracked files and
// carries no repository of its own (git cannot track files inside a directory containing
// .git), so the runner synthesizes the baseline commit in the work dir. "No repository" and
// "no changes" must therefore stop being indistinguishable: an empty diff silently scores
// every security verifier clean, which is the fail-open this fix closes.

const TASK: GoldenTask = {
  id: 't-plain',
  repoFixture: 'fixtures/plain',
  prompt: 'write the marker',
  role: 'coder',
  verifiers: [
    { kind: 'diff-match', mustContain: ['done'], mustNotContain: ['forbidden-word'] },
    { kind: 'security-gate', maxSeverity: 'low' },
  ],
  provenance: { source: 'human-decision', ref: 'A4 regression fixture, 2026-09-30' },
};

/** A corpus whose fixture directory has NO .git of its own. */
async function withPlainCorpus(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plain-'));
  try {
    const repo = path.join(root, 'fixtures/plain');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'hello.txt'), 'hello', 'utf8');
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify([TASK]), 'utf8');
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a plain fixture — no repository of its own — still yields a diff the verifiers can see', async () => {
  await withPlainCorpus(async (root) => {
    const scored: string[] = [];
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h-plain',
      attempts: 1,
      dispatch: async (_t, workDir) => {
        await writeFile(path.join(workDir, 'done.txt'), 'done', 'utf8');
        return 'wrote done';
      },
      // Records what the security verifier was handed, so "sees the change" is measured
      // rather than inferred from the pass verdict.
      securityScore: async (diff) => { scored.push(diff); return 'none'; },
    });

    const result = await runner.run();

    assert.deepEqual(result.solvedTaskIds, ['t-plain'], JSON.stringify(result.tasks[0]));
    assert.match(scored[0] ?? '', /done/, 'the security scorer must receive the change, not ""');
  });
});

test('a work dir that is not a repository is an error, never an empty diff', async () => {
  await withPlainCorpus(async (root) => {
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'b'.repeat(64), harnessId: 'h-norepo',
      attempts: 1,
      dispatch: async (_t, workDir) => {
        // What a coder could do to itself: destroy the baseline it is diffed against.
        await rm(path.join(workDir, '.git'), { recursive: true, force: true });
        return 'removed the repository';
      },
      securityScore: async () => 'none',
    });

    const result = await runner.run();

    assert.deepEqual(result.solvedTaskIds, [], 'a run whose diff cannot be computed is not a pass');
    assert.match(result.tasks[0]?.attempts[0]?.error ?? '', /cannot compute the golden diff/);
  });
});
