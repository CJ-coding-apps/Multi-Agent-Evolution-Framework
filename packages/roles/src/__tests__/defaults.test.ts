import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDefaultRegistry } from '@maf/tools';
import { DEFAULT_ROLE_SET, DEFAULT_ROLE_CATALOG } from '../defaults.js';
import { DEFAULT_MAX_TOOL_ITERATIONS } from '../RoleConfig.js';
import { isWriterRole } from '../isWriterRole.js';
import { RoleRegistry } from '../RoleRegistry.js';

test('DEFAULT_ROLE_SET covers coder/tester/security/reviewer/analyst', () => {
  const roles = new Set<string>(DEFAULT_ROLE_SET.roles.map((r) => r.role));
  for (const expected of ['coder', 'tester', 'security', 'reviewer', 'analyst']) {
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
  for (const roleName of ['security', 'reviewer', 'analyst']) {
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

test('no built-in reader is capped below the in-process loop default (F2)', () => {
  // A reader's cap must cover the chain a review or audit actually runs — `git.diff → fs.read →
  // grep → git.log → answer` — or it stops `budget_exhausted` on a task it would otherwise finish.
  // The cap that matters is the in-process loop's, since D-44 moves the built-in readers onto it.
  const readers = DEFAULT_ROLE_SET.roles.filter((r) => !isWriterRole(r));
  assert.ok(readers.length >= 3, 'the built-in readers are here to check');
  for (const role of readers) {
    assert.ok(
      (role.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS) >= DEFAULT_MAX_TOOL_ITERATIONS,
      `reader "${role.role}" caps at ${role.maxToolIterations}, below the loop default ${DEFAULT_MAX_TOOL_ITERATIONS}`,
    );
  }
});

test('the shipped .maf/roles.yaml caps no reader below the loop default either (F2)', async () => {
  // The built-in set above is one source of readers; this repository's own roles file is the one
  // `maf run` actually loads. Its `tester` holds `fs.write` and so is a writer here, which leaves the
  // same three readers the built-ins carry.
  const mafDir = path.resolve(__dirname, '../../../../.maf');
  const roles = await RoleRegistry.fromYamlOrDefault(path.join(mafDir, 'roles.yaml'), mafDir, createDefaultRegistry());
  const readers = roles.list().filter((r) => !isWriterRole(r));
  assert.ok(readers.length >= 3, 'the shipped readers are here to check');
  for (const role of readers) {
    assert.ok(
      (role.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS) >= DEFAULT_MAX_TOOL_ITERATIONS,
      `reader "${role.role}" caps at ${role.maxToolIterations}, below the loop default ${DEFAULT_MAX_TOOL_ITERATIONS}`,
    );
  }
});
