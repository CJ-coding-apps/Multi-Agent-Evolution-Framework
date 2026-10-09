import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotDiff, runIsolatedGit, GIT_EMPTY_TREE } from '../index.js';
import { commitFile, git, makeRepo } from './gitTestUtils.js';

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

test('runtime state a .gitignore already ignores — the .maf/.gitignore maf writes — does not break the diff', async () => {
  // Regression (F9 of the 0.3.0 release audit): `git add` refuses a pathspec item naming an ignored
  // path, an exclusion included, so once `.maf/.gitignore` ignored the runtime state, an in-place
  // run's review failed with "The following paths are ignored".
  const repo = await makeRepo('maf-snapshot-ignored-state-');
  try {
    const base = await git(['rev-parse', 'HEAD'], repo);
    await mkdir(path.join(repo, '.maf', 'transcripts'), { recursive: true });
    await writeFile(path.join(repo, '.maf', '.gitignore'), '/.gitignore\n/lcm.db\n/transcripts\n', 'utf8');
    await writeFile(path.join(repo, '.maf', 'lcm.db'), 'database bytes', 'utf8');
    await writeFile(path.join(repo, '.maf', 'transcripts', 't.jsonl'), '{}', 'utf8');
    await writeFile(path.join(repo, '.maf', 'memory.kuzu'), 'graph bytes, not ignored', 'utf8');
    await writeFile(path.join(repo, '.maf', 'policy.yaml'), 'rules: []\n', 'utf8');
    await writeFile(path.join(repo, 'change.txt'), 'the agent\'s change', 'utf8');

    const diff = await snapshotDiff(repo, base);
    assert.match(diff, /change\.txt/);
    assert.match(diff, /\.maf\/policy\.yaml/, 'configuration is reviewed');
    assert.doesNotMatch(diff, /lcm\.db|transcripts|memory\.kuzu/, 'runtime state is not, ignored or not');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── runIsolatedGit ignores the host's choice of repository (F1 of the 0.3.0 release audit, round 2) ──

/** A script that appends to `marker` and exits `code`: exit 1 from an fsmonitor hook tells git to scan. */
async function markerScript(file: string, marker: string, code = 0): Promise<void> {
  await writeFile(file, `#!/bin/sh\necho ran >> '${marker}'\nexit ${code}\n`, 'utf8');
  await chmod(file, 0o755);
}

/** Runs `body` with `vars` set on this process, as a shell that exported them would, then restores it. */
async function withHost<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the host's GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, object store and exported config do not move the diff to another repository", async () => {
  // MAF started from a git hook inherits these naming the user's repository. The gate must still
  // review the run's own tree as git's own diff, and must not write the other repository's index or
  // objects. Each variable on its own, so each is shown to be dropped, not merely outvoted by another.
  const other = await makeRepo('maf-snapshot-other-');
  try {
    await writeFile(path.join(other, 'elsewhere.txt'), "another repository's change\n", 'utf8');
    const o = (...p: string[]) => path.join(other, '.git', ...p);
    const cases: Array<[string, Record<string, string>]> = [
      ['GIT_DIR',               { GIT_DIR: o() }],
      ['GIT_WORK_TREE',         { GIT_WORK_TREE: other }],
      ['GIT_INDEX_FILE',        { GIT_INDEX_FILE: o('index') }],
      ['GIT_OBJECT_DIRECTORY',  { GIT_OBJECT_DIRECTORY: o('objects') }],
      ['GIT_COMMON_DIR',        { GIT_COMMON_DIR: o() }],
      ['the rest, together',    { GIT_ALTERNATE_OBJECT_DIRECTORIES: o('objects'), GIT_NAMESPACE: 'elsewhere' }],
      // What `git -c` exports to its children, and the counted form: either would turn the a/ b/ prefixes off.
      ['GIT_CONFIG_PARAMETERS', { GIT_CONFIG_PARAMETERS: "'diff.noprefix'='true'" }],
      ['GIT_CONFIG_COUNT',      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.noprefix', GIT_CONFIG_VALUE_0: 'true' }],
    ];
    for (const [what, vars] of cases) {
      const repo = await makeRepo('maf-snapshot-host-env-');
      try {
        // A base only this repository has, so reading it from the other one's object store fails.
        await commitFile(repo, 'only-here.txt', `${what}\n`, 'a commit only this repository has');
        const base = await git(['rev-parse', 'HEAD'], repo);
        await writeFile(path.join(repo, 'intended.txt'), 'the change under review\n', 'utf8');
        const [otherIndex, otherObjects] = [await realIndex(other), await git(['count-objects', '-v'], other)];

        const diff = await withHost(vars, () => snapshotDiff(repo, base));
        assert.match(diff, /^\+\+\+ b\/intended\.txt$/m, `${what}: the run's own change, as git's own diff`);
        assert.match(diff, /^\+the change under review$/m, what);
        assert.doesNotMatch(diff, /elsewhere|only-here/, `${what}: and nothing else`);
        // A caller's own environment still applies; the host's does not reach a plain call either.
        await withHost(vars, () => runIsolatedGit(repo, ['add', 'intended.txt']));
        assert.equal(await git(['diff', '--cached', '--name-only'], repo), 'intended.txt', `${what}: staged in this repository`);
        assert.deepEqual(await realIndex(other), otherIndex, `${what}: the other repository's index is untouched`);
        assert.equal(await git(['count-objects', '-v'], other), otherObjects, `${what}: and so are its objects`);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test("the host's GIT_CONFIG does not answer for the repository's own config", async () => {
  const repo = await makeRepo('maf-snapshot-git-config-');
  try {
    await writeFile(path.join(repo, '..', `${path.basename(repo)}.host-config`), '[user]\n\tname = host\n', 'utf8');
    const name = await withHost({ GIT_CONFIG: path.join(repo, '..', `${path.basename(repo)}.host-config`) },
      () => runIsolatedGit(repo, ['config', 'user.name']));
    assert.equal(name.stdout.trim(), 'MAF Test');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(path.join(repo, '..', `${path.basename(repo)}.host-config`), { force: true });
  }
});

test("a repository's own core.fsmonitor does not run during the gate's diff", async () => {
  const repo = await makeRepo('maf-snapshot-fsmonitor-');
  try {
    const marker = path.join(repo, '.git', 'fsmonitor-ran');
    // An agent-written script the repository's config names: relative, so it resolves in the tree.
    await markerScript(path.join(repo, 'fsmonitor.sh'), marker, 1);
    await git(['add', 'fsmonitor.sh'], repo);
    await git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fsmonitor'], repo);
    await git(['config', 'core.fsmonitor', './fsmonitor.sh'], repo);
    const base = await git(['rev-parse', 'HEAD'], repo);
    await writeFile(path.join(repo, 'change.txt'), 'changed\n', 'utf8');

    assert.match(await snapshotDiff(repo, base), /change\.txt/);
    await assert.rejects(readFile(marker, 'utf8'), 'the fsmonitor hook did not run');

    // Control: plain git runs it, or this test proves nothing.
    await git(['status', '--porcelain'], repo);
    assert.match(await readFile(marker, 'utf8'), /ran/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
