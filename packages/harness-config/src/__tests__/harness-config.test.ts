import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessRoleSet } from '../index.js';
import {
  HarnessStore,
  computeHarnessSha,
  mintHarnessConfig,
  HarnessIntegrityError,
} from '../index.js';

// ORACLE (harness-config plan §3.1): canonicalization/round-trip/tamper behavior
// is specified in HARNESSX_INTEGRATION_PLAN.md Phase 0 tests.

const ROLE_SET: HarnessRoleSet = {
  version: 1,
  defaultRole: 'coder',
  roles: [
    { role: 'coder', systemPrompt: 'be a coder', allowedTools: ['fs.read', 'fs.write'] },
    { role: 'tester', systemPrompt: 'be a tester', allowedTools: ['fs.read', 'test.run'] },
  ],
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-harness-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('canonicalization is stable across key insertion order', () => {
  const a = mintHarnessConfig({ id: 'x', roleSet: ROLE_SET, processorBundles: [] });
  const reordered: HarnessRoleSet = {
    defaultRole: ROLE_SET.defaultRole,
    version: 1,
    roles: [...ROLE_SET.roles].reverse().map((r) => ({
      allowedTools: [...r.allowedTools].reverse(),
      role: r.role,
      ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
    })),
  };
  // Note: array order IS significant (roles/allowedTools order matters); only key order must not.
  const b = mintHarnessConfig({ roleSet: ROLE_SET, processorBundles: [], id: 'x' });
  assert.equal(a.sha, b.sha);
  const c = mintHarnessConfig({ id: 'x', roleSet: reordered, processorBundles: [] });
  assert.notEqual(a.sha, c.sha, 'array order must affect the sha');
});

test('mint: identical content → identical sha; different content → different sha', () => {
  const a = mintHarnessConfig({ id: 'a', roleSet: ROLE_SET, processorBundles: [] });
  const b = mintHarnessConfig({ id: 'b', roleSet: ROLE_SET, processorBundles: [] });
  assert.notEqual(a.sha, b.sha);
  const a2 = mintHarnessConfig({ id: 'a', roleSet: ROLE_SET, processorBundles: [] });
  assert.equal(a.sha, a2.sha);
});

test('store save → load round-trip preserves sha', async () => {
  await withTempDir(async (dir) => {
    const store = new HarnessStore(dir);
    const cfg = mintHarnessConfig({ id: 'test-v1', roleSet: ROLE_SET, processorBundles: [] });
    await store.save(cfg);
    const bySha = await store.load(cfg.sha);
    const byId = await store.load('test-v1');
    assert.deepEqual(bySha, cfg);
    assert.deepEqual(byId, cfg);
  });
});

test('store: tampering with the file on disk fails integrity on load', async () => {
  await withTempDir(async (dir) => {
    const store = new HarnessStore(dir);
    const cfg = mintHarnessConfig({ id: 'victim', roleSet: ROLE_SET, processorBundles: [] });
    await store.save(cfg);
    const file = path.join(dir, 'harnesses', `${cfg.sha}.yaml`);
    const tampered = JSON.parse(await readFile(file, 'utf8'));
    tampered.roleSet.defaultRole = 'tester';
    await writeFile(file, JSON.stringify(tampered), 'utf8');
    await assert.rejects(() => store.load(cfg.sha), HarnessIntegrityError);
  });
});

test('adoptLegacy: first mint wins, sets CURRENT, idempotent', async () => {
  await withTempDir(async (dir) => {
    const store = new HarnessStore(dir);
    const first = await store.adoptLegacy(ROLE_SET);
    const second = await store.adoptLegacy({
      ...ROLE_SET,
      roles: [...ROLE_SET.roles, { role: 'reviewer', systemPrompt: 'review', allowedTools: [] }],
    });
    assert.equal(first.sha, second.sha, 'adoptLegacy must not re-mint when the id exists');
    const current = await store.current();
    assert.equal(current?.sha, first.sha);
    const all = await store.list();
    assert.equal(all.length, 1);
  });
});

test('list() returns all configs sorted by id; load(CURRENT) resolves pointer', async () => {
  await withTempDir(async (dir) => {
    const store = new HarnessStore(dir);
    const b = mintHarnessConfig({ id: 'b', roleSet: ROLE_SET, processorBundles: [] });
    const a = mintHarnessConfig({ id: 'a', roleSet: ROLE_SET, processorBundles: [{ name: 'x' }] });
    await store.save(b);
    await store.save(a);
    const ids = (await store.list()).map((c) => c.id);
    assert.deepEqual(ids, ['a', 'b']);
    await store.setCurrent(a.sha);
    assert.equal((await store.load('current')).sha, a.sha);
  });
});

test('load of unknown ref throws HarnessConfigError; files use .yaml JSON convention', async () => {
  await withTempDir(async (dir) => {
    const store = new HarnessStore(dir);
    await assert.rejects(() => store.load('nope'));
    const cfg = mintHarnessConfig({ id: 'x', roleSet: ROLE_SET, processorBundles: [] });
    await store.save(cfg);
    const names = await readdir(path.join(dir, 'harnesses'));
    assert.ok(names.includes(`${cfg.sha}.yaml`));
    assert.ok(names.includes('index.json'));
  });
});
