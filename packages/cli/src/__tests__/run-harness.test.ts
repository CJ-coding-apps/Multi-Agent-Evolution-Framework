import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessStore, mintHarnessConfig } from '@maf/harness-config';
import { createDefaultRegistry } from '@maf/tools';
import { resolveRunHarness } from '../wiring.js';
import { resolveGoldensHarness } from '../commands/goldens.js';
import { cliOnlyAdapter, driveRun, registryOf } from './runFixture.js';

// ORACLE: WP-2.9 + WP-2.7 integration (rule 3) — `run`, `goldens` and `evolve` pick their harness
// by one path: a stored ref or a committed default by id or sha prefix, else an operator-set
// CURRENT, else legacy-default minted from the roles file *now*. goldens and evolve used to load
// CURRENT directly, so a CURRENT that tracks the roles file evaluated a stale snapshot of it.

const REPO = path.resolve(__dirname, '../../../..');
const baseTools = createDefaultRegistry();

function rolesYaml(prompt: string): string {
  return [
    'version: 1',
    'defaultRole: coder',
    'roles:',
    '  - role: coder',
    `    systemPrompt: ${JSON.stringify(prompt)}`,
    '    allowedTools: [fs.read, fs.write]',
    '',
  ].join('\n');
}

async function withMafDir(body: (mafDir: string, rolesPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-harness-'));
  const mafDir = path.join(root, '.maf');
  await mkdir(mafDir, { recursive: true });
  const rolesPath = path.join(mafDir, 'roles.yaml');
  await writeFile(rolesPath, rolesYaml('version one'), 'utf8');
  try {
    await body(mafDir, rolesPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const resolve = (mafDir: string, rolesPath: string, ref?: string) =>
  resolveRunHarness({ store: new HarnessStore(mafDir), ref, rolesPath, mafDir, baseTools });

test('a plain run with no CURRENT mints legacy-default from the roles file and makes it CURRENT', async () => {
  await withMafDir(async (mafDir, rolesPath) => {
    const { harness, source } = await resolve(mafDir, rolesPath);
    assert.equal(source, 'legacy');
    assert.equal(harness.id, 'legacy-default');
    assert.equal(harness.roleSet.roles[0]?.systemPrompt, 'version one');
    assert.equal((await new HarnessStore(mafDir).current())?.sha, harness.sha);
  });
});

test('an operator-set CURRENT wins a plain run; legacy-default (what a typed --roles passes) does not read it', async () => {
  await withMafDir(async (mafDir, rolesPath) => {
    const store = new HarnessStore(mafDir);
    const chosen = mintHarnessConfig({
      id: 'chosen', processorBundles: [],
      roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: 'chosen', allowedTools: ['fs.read'] }] },
    });
    await store.save(chosen);
    await store.setCurrent(chosen.sha);

    const plain = await resolve(mafDir, path.join(mafDir, 'no-such-roles.yaml'));
    assert.equal(plain.source, 'current');
    assert.equal(plain.harness.sha, chosen.sha);

    const typedRoles = await resolve(mafDir, rolesPath, 'legacy-default');
    assert.equal(typedRoles.source, 'legacy', 'the roles file, not CURRENT');
    assert.equal(typedRoles.harness.roleSet.roles[0]?.systemPrompt, 'version one');
    assert.equal((await store.current())?.sha, chosen.sha, 'minting legacy-default never moves an operator-set CURRENT');
  });
});

test('a CURRENT that tracks the roles file follows an edit of it, in run and in goldens alike', async () => {
  await withMafDir(async (mafDir, rolesPath) => {
    const first = await resolve(mafDir, rolesPath);
    await writeFile(rolesPath, rolesYaml('version two'), 'utf8');

    const goldens = await resolveGoldensHarness(mafDir);
    assert.notEqual(goldens.harness.sha, first.harness.sha, 'goldens evaluates the roles file now, not the last snapshot');
    assert.equal(goldens.harness.roleSet.roles[0]?.systemPrompt, 'version two');
    assert.equal(goldens.source, path.join(mafDir, 'harnesses', `${goldens.harness.sha}.yaml`));
    assert.equal((await resolve(mafDir, rolesPath)).harness.sha, goldens.harness.sha, 'run resolves the same harness');
  });
});

test('a committed default answers to its id and short sha, and run imports it so the attestation can name it', async () => {
  await withMafDir(async (mafDir, rolesPath) => {
    const committedDir = path.join(REPO, '.maf', 'harnesses');
    const name = (await readdir(committedDir)).find((n) => /^default-[0-9a-f]{64}\.json$/.test(n));
    assert.ok(name, 'the repository commits a default harness');
    const store = new HarnessStore(mafDir);
    await mkdir(store.dir, { recursive: true });
    await copyFile(path.join(committedDir, name), path.join(store.dir, name));
    const sha = name.slice('default-'.length, -'.json'.length);
    // goldens reads it where it lies, as WP-2.7 decided, and stores nothing.
    assert.equal(path.basename((await resolveGoldensHarness(mafDir, 'default')).source), name);
    await assert.rejects(access(path.join(store.dir, `${sha}.yaml`)));

    for (const ref of ['default', sha.slice(0, 8)]) {
      const { harness, source } = await resolve(mafDir, rolesPath, ref);
      assert.equal(harness.sha, sha, `--harness ${ref}`);
      assert.equal(source, 'flag');
    }
    await access(path.join(store.dir, `${sha}.yaml`));
    assert.deepEqual(await store.configSource((await resolve(mafDir, rolesPath, 'default')).harness),
      { uri: path.join(store.dir, `${sha}.yaml`), digest: { sha256: sha } });
  });
});

test('a stored harness whose prompt lives in a file outside its sha is refused by ref', async () => {
  await withMafDir(async (mafDir, rolesPath) => {
    const store = new HarnessStore(mafDir);
    const loose = mintHarnessConfig({
      id: 'loose', processorBundles: [],
      roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', promptFile: 'prompts/coder.md', allowedTools: ['fs.read'] }] },
    });
    await store.save(loose);
    await assert.rejects(resolve(mafDir, rolesPath, 'loose'), /does not carry its text/);
    await assert.rejects(resolveGoldensHarness(mafDir, 'loose'), /does not carry its text/);
  });
});

test('run: a typed --roles is that file even when the operator set CURRENT; a plain run is CURRENT', async () => {
  await withMafDir(async (mafDir) => {
    const store = new HarnessStore(mafDir);
    const chosen = mintHarnessConfig({
      id: 'chosen', processorBundles: [],
      roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: 'chosen', allowedTools: ['fs.read'] }] },
    });
    await store.save(chosen);
    await store.setCurrent(chosen.sha);
    const root = path.dirname(mafDir);
    // The cli-only adapter stops each run right after the harness line (at the tier check or the
    // worktree), before any model call.
    const adapters = registryOf(cliOnlyAdapter('cli-only'));

    const plain = await driveRun(['t', '--dir', root, '--adapter', 'cli-only'], { adapters });
    assert.match(plain.out, new RegExp(`\\[maf\\] harness: chosen \\(${chosen.sha.slice(0, 8)}\\) \\[current\\]`));

    // The same value commander would default to, typed: only the flag's source tells them apart.
    const typed = await driveRun(['t', '--dir', root, '--adapter', 'cli-only', '--roles', '.maf/roles.yaml'], { adapters });
    assert.match(typed.out, /\[maf\] harness: legacy-default \([0-9a-f]{8}\) \[legacy\]/);
    assert.equal((await store.current())?.sha, chosen.sha, 'CURRENT is still the operator\'s');
  });
});
