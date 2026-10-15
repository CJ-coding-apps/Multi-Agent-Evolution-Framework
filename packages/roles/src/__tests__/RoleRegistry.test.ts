import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultRegistry } from '@maf/tools';
import { makeToolId } from '@maf/types';
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

// F8/M19: `expectsToolCalls: true` is a promise about the call count, so it must be able to mean
// something. On a role with no tool it can never be satisfied — the node has nothing to call, so every
// run ends `no_work`. On a writer it is inert whatever its value (R7), because no_change (D-32) judges
// the writer by the tree, never by its call count — so the setting is read and discarded. Both are
// refused where the set is validated.

test('F8: fromSet refuses expectsToolCalls: true on a role that holds no tool', () => {
  const tools = createDefaultRegistry();
  assert.throws(
    () => RoleRegistry.fromSet(
      {
        version: 1,
        defaultRole: defineRoleName('analyst'),
        roles: [{ role: defineRoleName('analyst'), systemPrompt: 'a', allowedTools: [], expectsToolCalls: true }],
      },
      '/tmp',
      tools,
    ),
    (err: unknown) => err instanceof RoleConfigError
      && /analyst/.test(err.message) && /expectsToolCalls/.test(err.message),
  );
});

test('F8: fromSet refuses expectsToolCalls: true on a writer, which no_change judges instead', () => {
  const tools = createDefaultRegistry();
  assert.throws(
    () => RoleRegistry.fromSet(
      {
        version: 1,
        defaultRole: defineRoleName('coder'),
        roles: [{ role: defineRoleName('coder'), systemPrompt: 'a', allowedTools: [makeToolId('fs.write')], expectsToolCalls: true }],
      },
      '/tmp',
      tools,
    ),
    (err: unknown) => err instanceof RoleConfigError
      && /coder/.test(err.message) && /write tool/.test(err.message),
  );
});

test('R7: fromSet refuses expectsToolCalls: false on a writer too — the value is never read', () => {
  // R7 widened F8. `true` on a writer is inert, and so is `false`: no_change (D-32) judges a writer by
  // the tree whatever it declares, so the ruling refuses *any* declared value on a writer rather than
  // let one be accepted and discarded.
  const tools = createDefaultRegistry();
  assert.throws(
    () => RoleRegistry.fromSet(
      {
        version: 1,
        defaultRole: defineRoleName('coder'),
        roles: [{ role: defineRoleName('coder'), systemPrompt: 'a', allowedTools: [makeToolId('fs.write')], expectsToolCalls: false }],
      },
      '/tmp',
      tools,
    ),
    (err: unknown) => err instanceof RoleConfigError
      && /coder/.test(err.message) && /write tool/.test(err.message),
  );
});

test('F8: a reader that holds a tool and declares expectsToolCalls is still accepted', () => {
  // The refusal above must not widen to every reader: a reader with tools is exactly the config the
  // setting is for, so it constructs.
  const tools = createDefaultRegistry();
  const reg = RoleRegistry.fromSet(
    {
      version: 1,
      defaultRole: defineRoleName('analyst'),
      roles: [{ role: defineRoleName('analyst'), systemPrompt: 'a', allowedTools: [makeToolId('fs.read')], expectsToolCalls: true }],
    },
    '/tmp',
    tools,
  );
  assert.equal(reg.getDefault().expectsToolCalls, true);
});

test('F8: a roles file whose expectsToolCalls is not a boolean is refused at the shape check', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-'));
  try {
    const yamlPath = path.join(dir, 'roles.yaml');
    // `isRoleSet` only checked `allowedTools` and the like; an `expectsToolCalls: "yes"` slipped through
    // and reached the dispatcher as a truthy string. It is a boolean or the file is not a role set.
    await writeFile(yamlPath, JSON.stringify({
      version: 1,
      defaultRole: 'analyst',
      roles: [{ role: 'analyst', systemPrompt: 'a', allowedTools: ['fs.read'], expectsToolCalls: 'yes' }],
    }), 'utf8');
    await assert.rejects(
      RoleRegistry.fromYamlOrDefault(yamlPath, dir, createDefaultRegistry()),
      (err: unknown) => err instanceof RoleConfigError && /does not match the role-set shape/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// D-43: the catalog entry carries what the planner needs to route a task — whether the role holds
// a write tool and whether it owes a change — read from the role's tools, never its name.
test('the catalog entry carries writes and expectsChange, from the role not its name', () => {
  const reg = RoleRegistry.fromSet(DEFAULT_ROLE_SET, '/tmp');
  const flags = reg.catalog().map((e) => [String(e.role), e.writes, e.expectsChange]);
  assert.deepEqual(flags, [
    ['coder',    true,  true],
    ['tester',   true,  false],
    ['security', false, false],
    ['reviewer', false, false],
    ['analyst',  false, false],
  ]);
  // `writes` follows the tools, not the name: a role named `tester` that holds `fs.write` is a writer.
  const custom = RoleRegistry.fromSet({
    version: 1, defaultRole: defineRoleName('tester'),
    roles: [{ role: defineRoleName('tester'), systemPrompt: 'x', allowedTools: [makeToolId('fs.write')] }],
  }, '/tmp');
  assert.equal(custom.catalog()[0]?.writes, true);
  assert.equal(custom.catalog()[0]?.expectsChange, false);
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
