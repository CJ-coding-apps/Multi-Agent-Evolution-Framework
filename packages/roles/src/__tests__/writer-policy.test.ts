import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { RoleRegistry } from '../RoleRegistry.js';

// ORACLE: IMPLEMENTATION_CHECKLIST_2026-09-25.md A3 — the writer lock is only worth
// anything if the predicate that feeds it is right in both directions. Serializing a
// reader costs concurrency; leaving a writer unserialized corrupts the tree.

const TOOLS = createDefaultRegistry();
// fs.read/fs.stat/fs.list/grep/git.diff/git.log are read; fs.write/git.commit/patch.apply
// are write; fs.delete/git.reset are dangerous; test.run is execute.

function registry(roles: Array<{ role: string; execution?: 'cli' | 'in-process'; allowedTools: string[] }>) {
  // No baseTools argument, so an unknown tool id is not rejected at construction —
  // the same position a real run is in when the registry lacks a tool a role names.
  return RoleRegistry.fromSet({
    version: 1,
    defaultRole: roles[0]?.role ?? 'coder',
    roles: roles.map((r) => ({
      role: r.role,
      systemPrompt: 'x',
      allowedTools: r.allowedTools as ToolId[],
      ...(r.execution ? { execution: r.execution } : {}),
    })),
  }, '/tmp/maf-writer-policy');
}

test('a CLI role is a writer even when every allowed tool is read-only', () => {
  const roles = registry([{ role: 'analyst', execution: 'cli', allowedTools: ['fs.read', 'grep'] }]);
  assert.equal(roles.writesToWorkingTree('analyst', TOOLS), true,
    'the CLI agent has its own file tools whatever the allowlist says');
});

test('a role with no execution field defaults to the CLI tier, and is a writer', () => {
  const roles = registry([{ role: 'analyst', allowedTools: ['fs.read'] }]);
  assert.equal(roles.writesToWorkingTree('analyst', TOOLS), true);
});

test('an in-process role whose every tool is read-level is not a writer', () => {
  const roles = registry([
    { role: 'reader', execution: 'in-process', allowedTools: ['fs.read', 'fs.list', 'grep', 'git.diff'] },
  ]);
  assert.equal(roles.writesToWorkingTree('reader', TOOLS), false,
    'every call it can make goes through the gate and can only read');
});

test('one write-level tool is enough to make an in-process role a writer', () => {
  for (const writish of ['fs.write', 'git.commit', 'patch.apply', 'fs.delete', 'test.run']) {
    const roles = registry([
      { role: 'reader', execution: 'in-process', allowedTools: ['fs.read', writish] },
    ]);
    assert.equal(roles.writesToWorkingTree('reader', TOOLS), true, `${writish} must count as writing`);
  }
});

test('an allowed tool the registry cannot resolve is treated as writing', () => {
  const roles = registry([
    { role: 'reader', execution: 'in-process', allowedTools: ['fs.read', 'mcp.unknown-server.tool'] },
  ]);
  assert.equal(roles.writesToWorkingTree('reader', TOOLS), true,
    'an unresolvable tool must not be assumed harmless');
});

test('an unknown role is a writer, never the default role\'s reader-ness', () => {
  // The default here is the read-only in-process role: the answer must not become
  // "not a writer" just because getRole would have handed back a reader.
  const roles = registry([
    { role: 'reader', execution: 'in-process', allowedTools: ['fs.read'] },
  ]);
  assert.equal(roles.writesToWorkingTree('read-only-auditor', TOOLS), true);
});
