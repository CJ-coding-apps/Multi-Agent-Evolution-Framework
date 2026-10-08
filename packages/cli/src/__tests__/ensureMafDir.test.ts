import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureMafDir } from '../ensureMafDir.js';

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
