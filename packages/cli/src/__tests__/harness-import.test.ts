import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { HarnessStore, canonicalJson, mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { importHarness, loadStoredHarness } from '../commands/harness.js';

// ORACLE: v0.2.0 audit P1 "Nonexistent commands referenced: `maf harness import`" and D-14 —
// import validates, copies and indexes a harness; where the store looks a harness up by ref, a
// short sha (what `harness list` prints) is accepted when it names exactly one.

const execFileAsync = promisify(execFile);
const MAIN = path.resolve(__dirname, '../main.js');

const harness = (id: string, prompt = 'You fix code.'): HarnessConfig => mintHarnessConfig({
  id, processorBundles: [],
  roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: prompt, allowedTools: ['fs.read'] }] },
});

/** A harness-shaped object with an honest sha, for content the HarnessConfig type would not admit. */
function withSha(fields: Record<string, unknown>): Record<string, unknown> {
  const base = { ...fields, version: 1 };
  return { ...base, sha: crypto.createHash('sha256').update(canonicalJson(base), 'utf8').digest('hex') };
}

async function withDir(fn: (dir: string, store: HarnessStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-import-'));
  try {
    await fn(dir, new HarnessStore(path.join(dir, '.maf')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeHarness(dir: string, cfg: unknown, name = 'h.json'): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(cfg, null, 2), 'utf8');
  return file;
}

test('maf harness import validates, copies and indexes a harness file', async () => {
  await withDir(async (dir, store) => {
    const cfg = harness('team');
    const file = await writeHarness(dir, cfg, `default-${cfg.sha}.json`);
    const { stdout } = await execFileAsync(process.execPath, [MAIN, 'harness', 'import', file, '-d', dir]);
    assert.match(stdout, new RegExp(`imported team \\(${cfg.sha.slice(0, 8)}\\)`));
    assert.deepEqual(await store.load('team'), cfg, 'indexed by id');
    assert.deepEqual(await store.load(cfg.sha), cfg, 'stored under its sha');
    assert.deepEqual(JSON.parse(await readFile(path.join(store.dir, 'index.json'), 'utf8')), { team: cfg.sha });
    assert.equal(await store.current(), undefined, 'import does not change CURRENT');
  });
});

test('import refuses a harness whose content is not what it claims, or that would repoint an id', async () => {
  await withDir(async (dir, store) => {
    const cfg = harness('team');
    const edited = { ...cfg, roleSet: { ...cfg.roleSet, defaultRole: 'other' } };
    await assert.rejects(async () => importHarness(store, await writeHarness(dir, edited)), /content hashes to/);
    await assert.rejects(async () => importHarness(store, await writeHarness(dir, cfg, `default-${'0'.repeat(64)}.json`)), /is named for sha 0{64}/);
    const badTier = withSha({ id: 't', processorBundles: [], roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', allowedTools: [], execution: 'remote' }] } });
    await assert.rejects(async () => importHarness(store, await writeHarness(dir, badTier)), /execution must be/);
    const badBundle = withSha({ id: 'b', roleSet: harness('b').roleSet, processorBundles: [{ name: 'no-such-processor' }] });
    await assert.rejects(async () => importHarness(store, await writeHarness(dir, badBundle)), /processor bundle\(s\) this maf does not have: no-such-processor/);
    await writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8');
    await assert.rejects(() => importHarness(store, path.join(dir, 'broken.json')), /could not be read as a JSON harness/);

    await importHarness(store, await writeHarness(dir, cfg));
    const sameIdOtherContent = harness('team', 'A different prompt.');
    await assert.rejects(async () => importHarness(store, await writeHarness(dir, sameIdOtherContent)), /already names .* refusing to point it at/);
    assert.equal((await store.load('team')).sha, cfg.sha, 'the id still names what it named');
    await importHarness(store, await writeHarness(dir, cfg));
  });
});

test('import refuses the ids the store reserves, in any case (D-39)', async () => {
  await withDir(async (dir, store) => {
    for (const id of ['legacy-default', 'current', 'CURRENT', 'Legacy-Default']) {
      await assert.rejects(
        async () => importHarness(store, await writeHarness(dir, harness(id))),
        new RegExp(`has the id "${id}", which maf reserves: .*Give the harness another id and mint it again before importing it\\.`),
        `an empty store must still refuse ${id}`,
      );
    }
    assert.deepEqual(await store.list(), [], 'nothing was copied or indexed');
    assert.equal(await store.tryLoad('legacy-default'), undefined, 'a plain run will still adopt roles.yaml as legacy-default');
  });
});

test('a short sha names a stored harness when exactly one starts with it', async () => {
  await withDir(async (dir, store) => {
    const a = harness('a');
    const b = harness('b');
    await store.save(a);
    await store.save(b);
    assert.equal((await loadStoredHarness(store, a.sha.slice(0, 8))).id, 'a');
    assert.equal((await loadStoredHarness(store, 'b')).id, 'b', 'ids still resolve');
    await assert.rejects(() => loadStoredHarness(store, 'abc'), /No harness found for ref "abc"/, 'under 4 hex digits is not a prefix');
    // F11 of the 0.3.0 release audit: `set-current 425` said only "No harness found".
    await assert.rejects(() => loadStoredHarness(store, a.sha.slice(0, 3)),
      new RegExp(`No harness found for ref "${a.sha.slice(0, 3)}" in .*\\. A sha prefix needs four or more hex digits, and "${a.sha.slice(0, 3)}" has three\\.$`));
    await assert.rejects(() => loadStoredHarness(store, 'no-such-id'), (err: Error) => !err.message.includes('prefix'));
    await assert.rejects(() => loadStoredHarness(store, 'ffff'.repeat(2)), /No harness found/);

    // Two shas sharing a prefix: forge the second file name, since content-addressed shas rarely collide in 4 digits.
    const twin = `${a.sha.slice(0, 4)}${'0'.repeat(60)}`;
    await writeFile(path.join(store.dir, `${twin}.yaml`), '{}', 'utf8');
    await assert.rejects(() => loadStoredHarness(store, a.sha.slice(0, 4)), /is ambiguous/);

    const { stdout } = await execFileAsync(process.execPath, [MAIN, 'harness', 'show', b.sha.slice(0, 10), '-d', dir]);
    assert.equal(JSON.parse(stdout).id, 'b', 'harness show takes a short sha');
  });
});
