import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessConfig, HarnessRoleSet } from '../index.js';
import {
  HarnessStore,
  HarnessConfigError,
  HarnessIntegrityError,
  LEGACY_DEFAULT_ID,
  computeHarnessSha,
  mintHarnessConfig,
  resolveHarnessRef,
} from '../index.js';

// ORACLE: which harness a run dispatches — `--harness` > CURRENT > legacy-default minted fresh —
// and that the attestation's config source names exactly that harness.

const ROLES_V1: HarnessRoleSet = {
  version: 1,
  defaultRole: 'coder',
  roles: [{ role: 'coder', systemPrompt: 'be a coder', allowedTools: ['fs.read', 'fs.write'] }],
};
const ROLES_V2: HarnessRoleSet = {
  version: 1,
  defaultRole: 'coder',
  roles: [{ role: 'coder', systemPrompt: 'be a careful coder', allowedTools: ['fs.read', 'fs.write'] }],
};

async function withStore(fn: (store: HarnessStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-harness-ref-'));
  try {
    await fn(new HarnessStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A legacy role-set source that counts its calls, so a test can say the roles file was not read. */
function legacy(roleSet: HarnessRoleSet) {
  const source = { calls: 0, legacyRoleSet: async () => { source.calls++; return roleSet; } };
  return source;
}

async function saved(store: HarnessStore, id: string, roleSet: HarnessRoleSet): Promise<HarnessConfig> {
  const cfg = mintHarnessConfig({ id, roleSet, processorBundles: [] });
  await store.save(cfg);
  return cfg;
}

/** What `maf harness set-current <ref>` does. */
async function setCurrent(store: HarnessStore, ref: string): Promise<void> {
  await store.setCurrent((await store.load(ref)).sha);
}

test('--harness given: that harness, by id or sha; the roles file is not read', async () => {
  await withStore(async (store) => {
    const pinned = await saved(store, 'pinned', ROLES_V1);
    const src = legacy(ROLES_V2);
    const byId = await resolveHarnessRef({ harness: 'pinned', legacyRoleSet: src.legacyRoleSet }, store);
    const bySha = await resolveHarnessRef({ harness: pinned.sha, legacyRoleSet: src.legacyRoleSet }, store);
    assert.deepEqual(byId, { harness: pinned, source: 'flag' });
    assert.deepEqual(bySha, { harness: pinned, source: 'flag' });
    assert.equal(src.calls, 0);
  });
});

test('--harness naming nothing in the store throws; it never falls back to another harness', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => resolveHarnessRef({ harness: 'nope', legacyRoleSet: legacy(ROLES_V1).legacyRoleSet }, store),
      HarnessConfigError,
    );
    await assert.rejects(
      () => resolveHarnessRef({ harness: '', legacyRoleSet: legacy(ROLES_V1).legacyRoleSet }, store),
      HarnessConfigError,
    );
  });
});

test('no --harness, no CURRENT: legacy-default minted fresh from the roles file, persisted, and made CURRENT', async () => {
  await withStore(async (store) => {
    const src = legacy(ROLES_V1);
    const { harness, source } = await resolveHarnessRef({ legacyRoleSet: src.legacyRoleSet }, store);
    assert.equal(source, 'legacy');
    assert.equal(harness.id, LEGACY_DEFAULT_ID);
    assert.deepEqual(harness.roleSet, ROLES_V1);
    assert.equal(src.calls, 1);
    assert.deepEqual(await store.load(harness.sha), harness);
    assert.equal((await store.current())?.sha, harness.sha);
  });
});

test('no --harness, CURRENT set by the operator: CURRENT; the roles file is not read', async () => {
  await withStore(async (store) => {
    const chosen = await saved(store, 'evolved-3', ROLES_V2);
    await setCurrent(store, 'evolved-3');
    const src = legacy(ROLES_V1);
    const resolved = await resolveHarnessRef({ legacyRoleSet: src.legacyRoleSet }, store);
    assert.deepEqual(resolved, { harness: chosen, source: 'current' });
    assert.equal(src.calls, 0);
  });
});

test('set-current changes what the next plain run uses', async () => {
  await withStore(async (store) => {
    const a = await saved(store, 'a', ROLES_V1);
    const b = await saved(store, 'b', ROLES_V2);
    const src = legacy(ROLES_V1);
    await setCurrent(store, 'a');
    assert.equal((await resolveHarnessRef({ legacyRoleSet: src.legacyRoleSet }, store)).harness.sha, a.sha);
    await setCurrent(store, b.sha);
    assert.equal((await resolveHarnessRef({ legacyRoleSet: src.legacyRoleSet }, store)).harness.sha, b.sha);
    // Pointing CURRENT back at legacy-default hands plain runs back to the roles file.
    await setCurrent(store, (await store.adoptLegacy(ROLES_V1)).sha);
    const back = await resolveHarnessRef({ legacyRoleSet: legacy(ROLES_V2).legacyRoleSet }, store);
    assert.equal(back.source, 'legacy');
    assert.deepEqual(back.harness.roleSet, ROLES_V2);
  });
});

test('a CURRENT naming a stale legacy-default snapshot (as 0.2.x left it) is never dispatched', async () => {
  // Regression (audit P2 "a run's recorded harness always matches the role set it ran with"):
  // 0.2.x minted legacy-default once and pointed CURRENT at it, so a plain run after editing
  // roles.yaml would have dispatched — and attested — the first role set forever.
  await withStore(async (store) => {
    const stale = await store.adoptLegacy(ROLES_V1);
    assert.equal((await store.current())?.sha, stale.sha);
    const { harness, source } = await resolveHarnessRef({ legacyRoleSet: legacy(ROLES_V2).legacyRoleSet }, store);
    assert.equal(source, 'legacy');
    assert.notEqual(harness.sha, stale.sha);
    assert.deepEqual(harness.roleSet, ROLES_V2);
    assert.equal(harness.sha, computeHarnessSha(harness));
    assert.equal((await store.current())?.sha, harness.sha);
    assert.equal((await store.load(LEGACY_DEFAULT_ID)).sha, harness.sha);
  });
});

test('--harness legacy-default and --harness current mean the roles file now, not the last snapshot', async () => {
  await withStore(async (store) => {
    const stale = await store.adoptLegacy(ROLES_V1);
    const viaId = await resolveHarnessRef({ harness: LEGACY_DEFAULT_ID, legacyRoleSet: legacy(ROLES_V2).legacyRoleSet }, store);
    assert.equal(viaId.source, 'legacy');
    assert.notEqual(viaId.harness.sha, stale.sha);
    assert.deepEqual(viaId.harness.roleSet, ROLES_V2);

    const chosen = await saved(store, 'chosen', ROLES_V1);
    await setCurrent(store, 'chosen');
    const viaCurrent = await resolveHarnessRef({ harness: 'current', legacyRoleSet: legacy(ROLES_V2).legacyRoleSet }, store);
    assert.deepEqual(viaCurrent, { harness: chosen, source: 'current' });
    // --harness legacy-default leaves an operator's CURRENT alone.
    await resolveHarnessRef({ harness: LEGACY_DEFAULT_ID, legacyRoleSet: legacy(ROLES_V1).legacyRoleSet }, store);
    assert.equal((await store.current())?.sha, chosen.sha);
  });
});

test('a harness that names a prompt file without carrying its text is refused: its sha would not identify the prompt', async () => {
  await withStore(async (store) => {
    const fileOnly: HarnessRoleSet = {
      version: 1, defaultRole: 'coder',
      roles: [{ role: 'coder', promptFile: 'prompts/coder.md', allowedTools: ['fs.read'] }],
    };
    const old = await saved(store, 'from-0-2', fileOnly);
    await assert.rejects(
      () => resolveHarnessRef({ harness: old.sha, legacyRoleSet: legacy(ROLES_V1).legacyRoleSet }, store),
      /prompts\/coder\.md.*does not carry its text/,
    );
    // The legacy source is checked before anything is minted or persisted.
    const before = await readdir(store.dir);
    await assert.rejects(
      () => resolveHarnessRef({ harness: LEGACY_DEFAULT_ID, legacyRoleSet: legacy(fileOnly).legacyRoleSet }, store),
      /prompts\/coder\.md.*does not carry its text/,
    );
    assert.deepEqual(await readdir(store.dir), before);
  });
});

test('configSource names the stored harness file and its sha, and refuses a harness that is not stored intact', async () => {
  await withStore(async (store) => {
    const { harness } = await resolveHarnessRef({ legacyRoleSet: legacy(ROLES_V1).legacyRoleSet }, store);
    const source = await store.configSource(harness);
    assert.deepEqual(source.digest, { sha256: harness.sha });
    const onDisk: unknown = JSON.parse(await readFile(source.uri, 'utf8'));
    assert.deepEqual(onDisk, harness);
    const unsaved = mintHarnessConfig({ id: 'never-saved', roleSet: ROLES_V2, processorBundles: [] });
    await assert.rejects(() => store.configSource(unsaved), HarnessConfigError);
    // A harness whose roles were edited in memory after it was resolved is no longer what its sha names.
    const edited: HarnessConfig = { ...harness, roleSet: ROLES_V2 };
    await assert.rejects(() => store.configSource(edited), HarnessIntegrityError);
  });
});
