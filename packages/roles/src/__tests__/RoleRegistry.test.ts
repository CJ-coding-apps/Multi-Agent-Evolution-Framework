import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultRegistry } from '@maf/tools';
import { RoleRegistry, RoleConfigError } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';

const VALID_YAML = JSON.stringify({
  version: 1,
  defaultRole: 'coder',
  roles: [
    { role: 'coder', systemPrompt: 'be a coder', allowedTools: ['fs.read', 'fs.write'] },
    { role: 'tester', systemPrompt: 'be a tester', allowedTools: ['fs.read', 'test.run'] },
  ],
});

test('fromYamlOrDefault parses valid yaml and validates tool ids', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-'));
  try {
    const yamlPath = path.join(dir, 'roles.yaml');
    await writeFile(yamlPath, VALID_YAML, 'utf8');
    const reg = await RoleRegistry.fromYamlOrDefault(yamlPath, dir, createDefaultRegistry());
    assert.equal(reg.getDefault().role, 'coder');
    assert.ok(reg.hasRole('tester'));
    assert.equal(reg.list().length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fromYamlOrDefault falls back to defaults when file missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-'));
  try {
    const reg = await RoleRegistry.fromYamlOrDefault(
      path.join(dir, 'does-not-exist.yaml'),
      dir,
      createDefaultRegistry(),
    );
    assert.equal(reg.getDefault().role, DEFAULT_ROLE_SET.defaultRole);
    assert.ok(reg.hasRole('coder'));
    assert.ok(reg.hasRole('tester'));
    assert.ok(reg.hasRole('security'));
    assert.ok(reg.hasRole('reviewer'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fromSet throws on duplicate role', () => {
  const tools = createDefaultRegistry();
  assert.throws(
    () => RoleRegistry.fromSet(
      {
        version: 1,
        defaultRole: defineRoleName('coder'),
        roles: [
          { role: defineRoleName('coder'), systemPrompt: 'a', allowedTools: [] },
          { role: defineRoleName('coder'), systemPrompt: 'b', allowedTools: [] },
        ],
      },
      '/tmp',
      tools,
    ),
    RoleConfigError,
  );
});

test('fromSet throws when allowedTools references unknown tool id', () => {
  const tools = createDefaultRegistry();
  assert.throws(
    () => RoleRegistry.fromSet(
      {
        version: 1,
        defaultRole: defineRoleName('coder'),
        roles: [{ role: defineRoleName('coder'), systemPrompt: 'a', allowedTools: ['nope.bogus' as never] }],
      },
      '/tmp',
      tools,
    ),
    RoleConfigError,
  );
});

test('fromSet throws when defaultRole missing from roles', () => {
  const tools = createDefaultRegistry();
  assert.throws(
    () => RoleRegistry.fromSet(
      {
        version: 1,
        defaultRole: defineRoleName('ghost'),
        roles: [{ role: defineRoleName('coder'), systemPrompt: 'a', allowedTools: [] }],
      },
      '/tmp',
      tools,
    ),
    RoleConfigError,
  );
});

test('resolveRole refuses an unknown name and lists the roles that exist', () => {
  // This replaces "getRole falls back to default on unknown name", which locked the behaviour
  // D-07 reports: `getRole('nonexistent')` answered with the set's default — `coder`, a writer —
  // so a hallucinated role name widened privilege and nothing said so.
  const reg = RoleRegistry.fromSet(DEFAULT_ROLE_SET, '/tmp');

  const resolved = reg.resolveRole('nonexistent');
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.requested, 'nonexistent');
    assert.deepEqual(resolved.error.known, reg.names());
    assert.ok(resolved.error.known.length > 0, 'the refusal must name the roles that do exist');
  }

  // A defined name still resolves, and `getRole` hands back that role's config.
  const coder = reg.resolveRole(DEFAULT_ROLE_SET.defaultRole);
  assert.ok(coder.ok);
  if (coder.ok) assert.equal(reg.getRole(coder.value), reg.getDefault());
});

test('catalog returns role + description pairs', () => {
  const reg = RoleRegistry.fromSet(DEFAULT_ROLE_SET, '/tmp');
  const cat = reg.catalog();
  assert.equal(cat.length, DEFAULT_ROLE_SET.roles.length);
  for (const entry of cat) {
    assert.equal(typeof entry.role, 'string');
    assert.equal(typeof entry.description, 'string');
  }
});

test('loadPrompt returns inline systemPrompt without filesystem read', async () => {
  const reg = RoleRegistry.fromSet(DEFAULT_ROLE_SET, '/this-path-does-not-exist');
  const prompt = await reg.loadPrompt(reg.getDefault());
  assert.ok(prompt.length > 0);
});

test('loadPrompt reads promptFile relative to mafDir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-'));
  try {
    await writeFile(path.join(dir, 'p.md'), 'role prompt content', 'utf8');
    const reg = RoleRegistry.fromSet({
      version: 1,
      defaultRole: defineRoleName('r'),
      roles: [{ role: defineRoleName('r'), promptFile: 'p.md', allowedTools: [] }],
    }, dir);
    const text = await reg.loadPrompt(reg.getDefault());
    assert.equal(text, 'role prompt content');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
