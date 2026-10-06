import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoleName, ToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { RoleRegistry, RoleConfigError } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';

// ORACLE: IMPLEMENTATION_CHECKLIST_2026-09-25.md A3 — the writer lock is only worth
// anything if the predicate that feeds it is right in both directions. Serializing a
// reader costs concurrency; leaving a writer unserialized corrupts the tree.

const TOOLS = createDefaultRegistry();
// fs.read/fs.stat/fs.list/grep/git.diff/git.log are read; fs.write/git.commit/patch.apply
// are write; fs.delete/git.reset are dangerous; test.run is execute.

/**
 * Defines a role set from a literal. This helper *authors* a set — the same act
 * `DEFAULT_ROLE_SET` and a parsed `roles.yaml` perform — so it is one of the few places in
 * this repo that mints a `RoleName`, and the assertions below reuse `defineRoleName` for the
 * names they passed in here.
 */
function registry(roles: Array<{ role: string; execution?: 'cli' | 'in-process'; allowedTools: string[] }>) {
  // No baseTools argument, so an unknown tool id is not rejected at construction —
  // the same position a real run is in when the registry lacks a tool a role names.
  return RoleRegistry.fromSet({
    version: 1,
    defaultRole: defineRoleName(roles[0]?.role ?? 'coder'),
    roles: roles.map((r) => ({
      role: defineRoleName(r.role),
      systemPrompt: 'x',
      allowedTools: r.allowedTools as ToolId[],
      ...(r.execution ? { execution: r.execution } : {}),
    })),
  }, '/tmp/maf-writer-policy');
}

test('a CLI role is a writer even when every allowed tool is read-only', () => {
  const roles = registry([{ role: 'analyst', execution: 'cli', allowedTools: ['fs.read', 'grep'] }]);
  assert.equal(roles.writesToWorkingTree(defineRoleName('analyst'), TOOLS), true,
    'the CLI agent has its own file tools whatever the allowlist says');
});

test('a role with no execution field defaults to the CLI tier, and is a writer', () => {
  const roles = registry([{ role: 'analyst', allowedTools: ['fs.read'] }]);
  assert.equal(roles.writesToWorkingTree(defineRoleName('analyst'), TOOLS), true);
});

test('an in-process role whose every tool is read-level is not a writer', () => {
  const roles = registry([
    { role: 'reader', execution: 'in-process', allowedTools: ['fs.read', 'fs.list', 'grep', 'git.diff'] },
  ]);
  assert.equal(roles.writesToWorkingTree(defineRoleName('reader'), TOOLS), false,
    'every call it can make goes through the gate and can only read');
});

test('one write-level tool is enough to make an in-process role a writer', () => {
  for (const writish of ['fs.write', 'git.commit', 'patch.apply', 'fs.delete', 'test.run']) {
    const roles = registry([
      { role: 'reader', execution: 'in-process', allowedTools: ['fs.read', writish] },
    ]);
    assert.equal(roles.writesToWorkingTree(defineRoleName('reader'), TOOLS), true, `${writish} must count as writing`);
  }
});

test('an allowed tool the registry cannot resolve is treated as writing', () => {
  const roles = registry([
    { role: 'reader', execution: 'in-process', allowedTools: ['fs.read', 'mcp.unknown-server.tool'] },
  ]);
  assert.equal(roles.writesToWorkingTree(defineRoleName('reader'), TOOLS), true,
    'an unresolvable tool must not be assumed harmless');
});

test("the sweep's repro: an unknown role name never becomes a role", () => {
  // This replaces "an unknown role is a writer, never the default role's reader-ness". That
  // test existed because an unknown name could reach `writesToWorkingTree`; the old `getRole`
  // answered it with the default role — here the read-only one — so the assertion was that the
  // writer predicate refused to inherit the default's reader-ness. A `RoleName` now comes only
  // from a role set that defines it, so the name never reaches the predicate; what remains
  // testable is that both halves refuse.
  const roles = registry([
    { role: 'reader', execution: 'in-process', allowedTools: ['fs.read'] },
  ]);

  const resolved = roles.resolveRole('read-only-auditor');
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.requested, 'read-only-auditor');
    assert.deepEqual(resolved.error.known, ['reader'], 'the refusal names the roles that do exist');
  }

  // `getRole` — the function the sweep called — refuses a name this set did not mint, even
  // when the name is real elsewhere: `coder` is `DEFAULT_ROLE_SET`'s default, not ours.
  assert.ok(DEFAULT_ROLE_SET.roles.some((r) => r.role === DEFAULT_ROLE_SET.defaultRole));
  assert.throws(() => roles.getRole(DEFAULT_ROLE_SET.defaultRole), RoleConfigError);
});
