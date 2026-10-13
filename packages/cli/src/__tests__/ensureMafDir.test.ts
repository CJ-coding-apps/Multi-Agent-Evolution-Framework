import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAF_RUNTIME_STATE, runIsolatedGit } from '@maf/git-ops';
import { MAF_DIR_GITIGNORE, ensureMafDir } from '../ensureMafDir.js';

// ORACLE: audit P0 #6 (WP-1.9) — `maf run -d <repo>` opened `<repo>/.maf/lcm.db` and
// `memory.kuzu` before anything created `.maf/`, so it crashed on every repository maf had
// never run in. `ensureMafDir` is the fix; the last test pins where `run` calls it.

/** From `packages/cli/dist/__tests__/` up to the package root. */
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

async function withTmp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-ensure-dir-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('creates the directory, missing parents included, and returns its path', async () => {
  await withTmp(async (root) => {
    const dir = path.join(root, 'repo', '.maf');

    assert.equal(await ensureMafDir(dir), dir);
    assert.ok((await stat(dir)).isDirectory(), `${dir} must exist as a directory`);
  });
});

test('is idempotent: a second call succeeds and leaves what is inside alone', async () => {
  await withTmp(async (root) => {
    const dir = path.join(root, '.maf');
    await ensureMafDir(dir);
    await writeFile(path.join(dir, 'lcm.db'), 'existing state', 'utf8');

    assert.equal(await ensureMafDir(dir), dir);
    assert.equal(await readFile(path.join(dir, 'lcm.db'), 'utf8'), 'existing state',
      'a repeat call must not disturb existing state');
  });
});

test('refuses a path that exists and is not a directory, naming it', async () => {
  await withTmp(async (root) => {
    const dir = path.join(root, '.maf');
    await writeFile(dir, 'not a directory', 'utf8');

    await assert.rejects(
      () => ensureMafDir(dir),
      (e: Error) => {
        assert.match(e.message, /exists and is not a directory/);
        assert.ok(e.message.includes(dir), `the error must name the path; got: ${e.message}`);
        return true;
      },
    );
    assert.equal(await readFile(dir, 'utf8'), 'not a directory', 'the file in the way must be left as it was');
  });
});

test('run creates .maf/ before it constructs any store that opens a file inside it', async () => {
  // The end-to-end proof is the fresh-clone run (WP-1.12); this holds the ordering in
  // place meanwhile, because a later edit that moves a store above the call would bring
  // the crash back with no compile error.
  const source = await readFile(path.join(PACKAGE_ROOT, 'src', 'commands', 'run.ts'), 'utf8');
  const call = source.indexOf('await ensureMafDir(mafDir)');
  assert.ok(call >= 0, 'run.ts must call `await ensureMafDir(mafDir)`');

  for (const store of ['new LcmEngine(', 'new MemoryGraph(']) {
    const at = source.indexOf(store);
    assert.ok(at >= 0,
      `run.ts no longer contains \`${store}\`; point this test at wherever the store is now constructed`);
    assert.ok(call < at, `\`${store}\` opens a file under .maf/ and must come after ensureMafDir(mafDir)`);
  }
});

// ORACLE (F9 of the 0.3.0 release audit): after a run the user's `git status` showed `?? .maf/`, and
// `git add -A` would have staged the memory graph, the LCM database, transcripts, bundles and
// harnesses. `.maf/.gitignore` lists the runtime state the security gate leaves out of its diff
// (MAF_RUNTIME_STATE), so only configuration the user chooses to commit is left to show.

/** What a run leaves under `.maf/`: every runtime-state entry, the worktrees, and the config. */
async function leaveRunState(mafDir: string): Promise<void> {
  for (const entry of MAF_RUNTIME_STATE) {
    const at = path.join(mafDir, entry);
    if (/\.(db|kuzu)|-wal$|-shm$/.test(entry)) {
      await writeFile(at, 'state', 'utf8');
    } else {
      await mkdir(at, { recursive: true });
      await writeFile(path.join(at, 'some-state.json'), '{}', 'utf8');
    }
  }
  await writeFile(path.join(mafDir, 'harnesses', 'CURRENT'), 'a'.repeat(64), 'utf8');
  await mkdir(path.join(mafDir, 'worktrees', 'run1'), { recursive: true });
  await writeFile(path.join(mafDir, 'worktrees', '.gitignore'), '*\n', 'utf8');
  await writeFile(path.join(mafDir, 'policy.yaml'), 'rules: []\n', 'utf8');
}

async function untracked(repo: string): Promise<string[]> {
  const { stdout } = await runIsolatedGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  return stdout.split('\n').filter(Boolean).sort();
}

test('after a run, git status shows only the configuration under .maf/, and a committed default harness stays addable', async () => {
  await withTmp(async (root) => {
    await runIsolatedGit(root, ['init', '-q']);
    const mafDir = await ensureMafDir(path.join(root, '.maf'));
    await leaveRunState(mafDir);
    await writeFile(path.join(mafDir, 'harnesses', 'default-abc.json'), '{}', 'utf8');

    assert.deepEqual(await untracked(root), ['?? .maf/harnesses/default-abc.json', '?? .maf/policy.yaml']);

    // The control: without the file, the runtime state is all there for `git add -A` to take.
    await rm(path.join(mafDir, '.gitignore'));
    const without = await untracked(root);
    assert.ok(without.includes('?? .maf/lcm.db') && without.includes('?? .maf/memory.kuzu') && without.length > 10, without.join('\n'));
  });
});

test('.maf/.gitignore is derived from MAF_RUNTIME_STATE, and one the user already has is left alone', async () => {
  for (const entry of MAF_RUNTIME_STATE) {
    const line = entry === 'harnesses' ? '/harnesses/*' : `/${entry}`;
    assert.ok(MAF_DIR_GITIGNORE.split('\n').includes(line), `${line} is listed`);
  }
  await withTmp(async (root) => {
    const dir = path.join(root, '.maf');
    await mkdir(dir);
    await writeFile(path.join(dir, '.gitignore'), 'mine\n', 'utf8');
    await ensureMafDir(dir);
    assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), 'mine\n');
  });
});

test('this repository\'s own .gitignore ignores every runtime-state entry, as MAF_RUNTIME_STATE says it does', async () => {
  await withTmp(async (root) => {
    await runIsolatedGit(root, ['init', '-q']);
    await copyFile(path.resolve(PACKAGE_ROOT, '..', '..', '.gitignore'), path.join(root, '.gitignore'));
    for (const entry of MAF_RUNTIME_STATE) {
      const probe = `.maf/${entry}/x`;
      const ignored = await runIsolatedGit(root, ['check-ignore', '--no-index', '-q', `.maf/${entry}`])
        .then(() => true, () => runIsolatedGit(root, ['check-ignore', '--no-index', '-q', probe]).then(() => true, () => false));
      assert.ok(ignored, `.maf/${entry} is ignored by the root .gitignore`);
    }
  });
});
