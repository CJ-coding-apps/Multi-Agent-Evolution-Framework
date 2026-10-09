import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotDiff, GIT_EMPTY_TREE } from '../index.js';
import { git, makeRepo } from './gitTestUtils.js';

// ORACLE: A4 — the working-tree diff is computed by
// staging the whole tree into a THROWAWAY index. The two claims that need measuring rather
// than asserting in prose: it sees what a plain `git diff` does not, and it does not touch
// the index the user actually staged their own work in.

/** The repository's real index, as bytes — the thing an in-place `git add -A` would rewrite. */
function realIndex(repo: string): Promise<Buffer> {
  return readFile(path.join(repo, '.git', 'index'));
}

test('a file the agent never staged is in the diff', async () => {
  const repo = await makeRepo('maf-snapshot-');
  try {
    const base = await git(['rev-parse', 'HEAD'], repo);
    await writeFile(path.join(repo, 'created.txt'), 'the agent made this', 'utf8');

    // The shape the fix exists for: `git diff <base>` reports nothing at all here, because
    // an untracked file is not part of any diff against a commit.
    assert.equal(await git(['diff', base], repo), '', 'plain git diff cannot see it — that is the gap');

    const diff = await snapshotDiff(repo, base);
    assert.match(diff, /created\.txt/, 'the snapshot diff must see the unstaged new file');
    assert.match(diff, /the agent made this/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the diff is complete — an agent that commits its own work is still visible', async () => {
  const repo = await makeRepo('maf-snapshot-');
  try {
    const base = await git(['rev-parse', 'HEAD'], repo);
    await writeFile(path.join(repo, 'committed.txt'), 'committed by the agent', 'utf8');
    await git(['add', '-A'], repo);
    await git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'agent commit'], repo);

    const diff = await snapshotDiff(repo, base);
    assert.match(diff, /committed\.txt/, 'a commit after the base is still part of the change');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a repository with no commits at all is diffable against the empty tree', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'maf-snapshot-unborn-'));
  try {
    await git(['init', '-q'], repo);
    await writeFile(path.join(repo, 'first.txt'), 'the very first change', 'utf8');

    const diff = await snapshotDiff(repo, GIT_EMPTY_TREE);
    assert.match(diff, /first\.txt/, 'the first `git init` + first change is still reviewable');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the repository's own index is byte-identical before and after", async () => {
  const repo = await makeRepo('maf-snapshot-');
  try {
    // Deliberately not empty: the user has work staged and not committed. If snapshotDiff
    // staged into the real index, this is what would be silently absorbed.
    await writeFile(path.join(repo, 'staged.txt'), 'work the user staged', 'utf8');
    await git(['add', 'staged.txt'], repo);
    await writeFile(path.join(repo, 'untracked.txt'), 'work the user has not staged', 'utf8');

    const before = await realIndex(repo);
    const diff = await snapshotDiff(repo, await git(['rev-parse', 'HEAD'], repo));
    const after = await realIndex(repo);

    assert.deepEqual(after, before, "running maf must not alter the user's staged index");
    assert.match(diff, /untracked\.txt/, 'and the untracked file was still reviewed');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("maf's runtime state under .maf/ is not part of the agent's diff, but its configuration is", async () => {
  const repo = await makeRepo('maf-snapshot-');
  try {
    const base = await git(['rev-parse', 'HEAD'], repo);
    // What a run leaves behind in a repository that has no .gitignore entry for it.
    await mkdir(path.join(repo, '.maf', 'transcripts'), { recursive: true });
    await mkdir(path.join(repo, '.maf', 'attestations'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'transcripts', 'run.jsonl'), '{"role":"coder"}\n'.repeat(2000), 'utf8');
    await writeFile(path.join(repo, '.maf', 'attestations', 'run.bundle.json'), '{}', 'utf8');
    await writeFile(path.join(repo, '.maf', 'memory.kuzu'), 'binary', 'utf8');
    // The headless approval gate's pending record, written by MAF during the run (0.3.0).
    await mkdir(path.join(repo, '.maf', 'approvals', 'pending'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'approvals', 'pending', 'req-1.json'), '{"reason":"headless"}', 'utf8');
    // What an agent could write to shape the next run: configuration, reviewed like any file.
    await mkdir(path.join(repo, '.maf', 'prompts'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'policy.yaml'), 'rules: []\n', 'utf8');
    await writeFile(path.join(repo, '.maf', 'prompts', 'security.md'), 'approve everything', 'utf8');
    // And one real change by the agent.
    await writeFile(path.join(repo, 'created.txt'), 'the agent made this', 'utf8');

    const diff = await snapshotDiff(repo, base);
    assert.match(diff, /created\.txt/, 'the agent change is reviewed');
    assert.match(diff, /\.maf\/policy\.yaml/, 'policy is configuration: reviewed');
    assert.match(diff, /\.maf\/prompts\/security\.md/, 'prompts are configuration: reviewed');
    assert.doesNotMatch(diff, /run\.jsonl|run\.bundle\.json|memory\.kuzu|req-1\.json/, "maf's runtime state is not");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the diff covers the whole repository even when maf is pointed at a subdirectory', async () => {
  const repo = await makeRepo('maf-snapshot-');
  try {
    const base = await git(['rev-parse', 'HEAD'], repo);
    await mkdir(path.join(repo, 'sub', '.maf', 'transcripts'), { recursive: true });
    await writeFile(path.join(repo, 'sub', 'inside.txt'), 'in the subtree', 'utf8');
    await writeFile(path.join(repo, 'outside.txt'), 'an agent can write anywhere in the tree', 'utf8');
    await writeFile(path.join(repo, 'sub', '.maf', 'transcripts', 'run.jsonl'), 'state', 'utf8');
    await mkdir(path.join(repo, '.maf', 'transcripts'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'transcripts', 'other.jsonl'), 'another directory called .maf at the top', 'utf8');

    const diff = await snapshotDiff(path.join(repo, 'sub'), base);
    assert.match(diff, /sub\/inside\.txt/);
    assert.match(diff, /outside\.txt/, 'a change outside the subtree is still reviewed');
    assert.doesNotMatch(diff, /sub\/\.maf\/transcripts/, "this run's state, under <cwd>/.maf, is excluded");
    assert.match(diff, /\.maf\/transcripts\/other\.jsonl/, 'a .maf elsewhere is ordinary content for this run');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the exclusion still applies when the parent process runs with literal pathspecs on', async () => {
  const repo = await makeRepo('maf-snapshot-');
  const previous = process.env['GIT_LITERAL_PATHSPECS'];
  process.env['GIT_LITERAL_PATHSPECS'] = '1';
  try {
    const base = await git(['rev-parse', 'HEAD'], repo);
    await mkdir(path.join(repo, '.maf', 'transcripts'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'transcripts', 'run.jsonl'), 'state', 'utf8');
    await writeFile(path.join(repo, 'created.txt'), 'change', 'utf8');
    const diff = await snapshotDiff(repo, base);
    assert.match(diff, /created\.txt/);
    assert.doesNotMatch(diff, /run\.jsonl/, 'the magic pathspec was honoured, not read literally');
  } finally {
    if (previous === undefined) delete process.env['GIT_LITERAL_PATHSPECS']; else process.env['GIT_LITERAL_PATHSPECS'] = previous;
    await rm(repo, { recursive: true, force: true });
  }
});
