import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GoldenRunner } from '../index.js';
import type { GoldenTask } from '../index.js';

const execFileAsync = promisify(execFile);

/** Runs git in a fixture work dir, the way a coder agent would. */
function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', args, { cwd });
}

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

test('a run whose diff cannot be computed is an error, never an empty diff', async () => {
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
    assert.match(result.tasks[0]?.attempts[0]?.error ?? '', /cannot compute the working-tree diff/);
  });
});

test('a coder that commits its own work is still diffed against the baseline', async () => {
  await withPlainCorpus(async (root) => {
    const scored: string[] = [];
    let headBefore = '';
    let headAfter = '';
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'c'.repeat(64), harnessId: 'h-commits',
      attempts: 1,
      dispatch: async (_t, workDir) => {
        // Claude Code commonly commits what it changes. Diffing against HEAD would see
        // nothing at all, and the security verifier would be handed an empty diff.
        headBefore = (await git(workDir, 'rev-parse', 'HEAD')).stdout.trim();
        await writeFile(path.join(workDir, 'done.txt'), 'done', 'utf8');
        await git(workDir, 'add', '-A');
        // The identity is passed explicitly, the way the runner passes its own on the
        // baseline commit. It is not decoration: `git commit` fails wherever the host has
        // no user.email, which is the case on a CI runner, and this test would then be
        // asserting about a commit that never happened.
        await git(
          workDir,
          '-c', 'user.name=golden coder',
          '-c', 'user.email=coder@maf.invalid',
          '-c', 'commit.gpgsign=false',
          'commit', '-qm', 'agent committed',
        );
        headAfter = (await git(workDir, 'rev-parse', 'HEAD')).stdout.trim();
        return 'wrote and committed done';
      },
      securityScore: async (diff) => { scored.push(diff); return 'none'; },
    });

    const result = await runner.run();
    const attemptError = result.tasks[0]?.attempts[0]?.error ?? 'none';

    // Without this the test also passes for a coder that never committed — the case the
    // test above already covers — and so says nothing about committing at all. It passed
    // that way until a runner without a git identity ran it and the diff came back empty.
    assert.match(headAfter, /^[0-9a-f]{40}$/,
      `the coder's commit did not land, so nothing here is about committing; attempt error: ${attemptError}`);
    assert.notEqual(headAfter, headBefore,
      `the coder did not create a new commit; attempt error: ${attemptError}`);

    assert.match(scored[0] ?? '', /done/,
      `the committed change must still be visible to the scorer; attempt error: ${attemptError}`);
  });
});

test('a hostile host git config cannot reach the golden repo', async () => {
  await withPlainCorpus(async (root) => {
    // A global config that would break any runner reading it: a failing pre-commit hook
    // and a branch name that is not the pinned one. Both are what GIT_CONFIG_GLOBAL=/dev/null
    // and -c core.hooksPath=/dev/null exist to stop.
    const hostile = path.join(root, 'hostile');
    const hooks = path.join(hostile, 'hooks');
    const marker = path.join(hostile, 'hook-ran');
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, 'utf8');
    await chmod(path.join(hooks, 'pre-commit'), 0o755);
    await writeFile(
      path.join(hostile, 'gitconfig'),
      `[core]\n\thooksPath = ${hooks}\n[init]\n\tdefaultBranch = hostile\n[commit]\n\tgpgsign = true\n`,
      'utf8',
    );

    const previous = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = path.join(hostile, 'gitconfig');
    try {
      let branch = '';
      const runner = new GoldenRunner({
        corpusRoot: root, harnessSha: 'd'.repeat(64), harnessId: 'h-hostile',
        attempts: 1,
        dispatch: async (_t, workDir) => {
          branch = (await git(workDir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
          await writeFile(path.join(workDir, 'done.txt'), 'done', 'utf8');
          return 'wrote done';
        },
        securityScore: async () => 'none',
      });

      const result = await runner.run();

      assert.deepEqual(result.solvedTaskIds, ['t-plain'], 'the baseline commit must still succeed');
      assert.equal(branch, 'maf-baseline', 'the pinned branch wins over the host default');
      await assert.rejects(() => access(marker), 'the host pre-commit hook must never run');
    } finally {
      if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = previous;
    }
  });
});
