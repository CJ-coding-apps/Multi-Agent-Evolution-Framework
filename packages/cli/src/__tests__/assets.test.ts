import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetsRoot, goldensAssetRoot, readAsset } from '../assets.js';
import { resolveCorpusRoot } from '../wiring.js';

// ORACLE: the package carries its own copy of what a run needs, and a copy that is not the
// repository's is worse than none — `.maf/policy.yaml` would deny a different set of calls from
// the one the README and docs/POLICY.md describe, and the goldens would score a corpus nobody measured.
// Every file is compared byte for byte, in both directions, so an added or removed file fails too.

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

/** source directory → asset directory, for everything embedded in the package. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['.maf', 'assets'],
  ['tests/goldens', 'assets/goldens'],
];

const TOP_LEVEL_FILES = ['policy.yaml', 'roles.yaml', 'config.yaml'];

async function walk(root: string, rel = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = rel === '' ? entry.name : path.join(rel, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

test('every embedded asset is byte-identical to the repository file it came from', async () => {
  const sources = new Map<string, string>();
  for (const name of TOP_LEVEL_FILES) sources.set(name, path.join(REPO, '.maf', name));
  for (const name of await walk(path.join(REPO, '.maf', 'prompts'))) {
    sources.set(path.join('prompts', name), path.join(REPO, '.maf', 'prompts', name));
  }
  for (const name of await walk(path.join(REPO, 'tests', 'goldens'))) {
    sources.set(path.join('goldens', name), path.join(REPO, 'tests', 'goldens', name));
  }

  const embedded = await walk(assetsRoot());
  assert.deepEqual(embedded, [...sources.keys()].sort(),
    'the embedded asset list has drifted from .maf/ and tests/goldens/');

  for (const [rel, source] of sources) {
    const fromRepo = await readFile(source);
    const fromPackage = await readFile(path.join(assetsRoot(), rel));
    assert.ok(fromRepo.equals(fromPackage), `assets/${rel} differs from ${path.relative(REPO, source)}`);
  }
});

test('readAsset resolves beside the module, not beside the caller', async () => {
  const policy = await readAsset('policy.yaml');
  assert.equal(policy, await readFile(path.join(REPO, '.maf', 'policy.yaml'), 'utf8'));
  // A caller's cwd is irrelevant: run from the repository root, where .maf/policy.yaml also
  // exists, and the text still comes from the package's own assets/.
  assert.equal(await readAsset('policy.yaml'), policy);
});

test('readAsset refuses a path that leaves assets/', async () => {
  await assert.rejects(() => readAsset('../package.json'), /outside .*assets/);
  await assert.rejects(() => readAsset('/etc/hosts'), /outside .*assets/);
});

test('goldens fall back to the packaged corpus when the repository has neither .maf/goldens nor tests/goldens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-corpus-fallback-'));
  try {
    // An installed package in a user's repository: no checkout, no corpus of its own.
    assert.equal(await resolveCorpusRoot(root, '.maf/goldens'), goldensAssetRoot());
    assert.ok((await readFile(path.join(goldensAssetRoot(), 'corpus.json'), 'utf8')).length > 0);

    // A corpus the repository does have still wins.
    const own = path.join(root, '.maf', 'goldens');
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, 'corpus.json'), '{"tasks":[]}\n', 'utf8');
    assert.equal(await resolveCorpusRoot(root, '.maf/goldens'), own);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
