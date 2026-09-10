import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROLE_SET, DEFAULT_ROLE_CATALOG } from '../defaults.js';

test('DEFAULT_ROLE_SET covers coder/tester/security/reviewer', () => {
  const roles = new Set(DEFAULT_ROLE_SET.roles.map((r) => r.role));
  for (const expected of ['coder', 'tester', 'security', 'reviewer']) {
    assert.ok(roles.has(expected), `missing role ${expected}`);
  }
  assert.equal(DEFAULT_ROLE_SET.defaultRole, 'coder');
});

test('every default role has either systemPrompt or promptFile', () => {
  for (const r of DEFAULT_ROLE_SET.roles) {
    assert.ok(r.systemPrompt || r.promptFile, `role ${r.role} needs a prompt source`);
  }
});

test('catalog mirrors role set length', () => {
  assert.equal(DEFAULT_ROLE_CATALOG.length, DEFAULT_ROLE_SET.roles.length);
});

test('read-only roles cannot write through their allowedTools', () => {
  for (const roleName of ['security', 'reviewer']) {
    const role = DEFAULT_ROLE_SET.roles.find((r) => r.role === roleName)!;
    const writeIds = ['fs.write', 'fs.delete', 'patch.apply', 'git.add', 'git.commit'];
    for (const id of writeIds) {
      assert.ok(
        !role.allowedTools.includes(id as never),
        `role ${roleName} unexpectedly grants ${id}`,
      );
    }
  }
});
