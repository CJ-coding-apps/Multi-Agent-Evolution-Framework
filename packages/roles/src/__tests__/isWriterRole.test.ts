import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { isWriterRole } from '../isWriterRole.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';

// ORACLE: D-07 — the security gate applies to every role that holds a write tool. The predicate
// is the whole of that rule, so it is tested in both directions: a writer it misses goes
// unreviewed, and a reader it catches is made to need a repository it does not use.

const tools = (ids: string[]) => ({ allowedTools: ids.map((id) => makeToolId(id)) });

const TABLE: Array<{ name: string; allowedTools: string[]; writer: boolean }> = [
  { name: 'no tools',                    allowedTools: [],                                   writer: false },
  { name: 'every read tool',             allowedTools: ['fs.read', 'fs.list', 'fs.stat', 'grep', 'git.status', 'git.diff', 'git.log'], writer: false },
  // F10 of the 0.3.0 release audit: test.run runs the project's own code, which can change the tree.
  { name: 'test.run alone',              allowedTools: ['test.run'],                         writer: true },
  { name: 'read tools and test.run',     allowedTools: ['fs.read', 'grep', 'test.run'],      writer: true },
  { name: 'a near-miss id',              allowedTools: ['fs.writer', 'git.commits', 'patch'], writer: false },
  { name: 'fs.write',                    allowedTools: ['fs.write'],                         writer: true },
  { name: 'fs.delete',                   allowedTools: ['fs.delete'],                        writer: true },
  { name: 'patch.apply',                 allowedTools: ['patch.apply'],                      writer: true },
  { name: 'git.commit',                  allowedTools: ['git.commit'],                       writer: true },
  { name: 'git.reset',                   allowedTools: ['git.reset'],                        writer: true },
  { name: 'git.add',                     allowedTools: ['git.add'],                          writer: true },
  { name: 'one write tool among readers', allowedTools: ['fs.read', 'grep', 'git.add', 'git.log'], writer: true },
];

for (const row of TABLE) {
  test(`isWriterRole: ${row.name} → ${row.writer ? 'writer' : 'not a writer'}`, () => {
    assert.equal(isWriterRole(tools(row.allowedTools)), row.writer);
  });
}

test('isWriterRole: the default role set — coder and tester write, security and reviewer do not', () => {
  const verdicts = Object.fromEntries(
    DEFAULT_ROLE_SET.roles.map((r): [string, boolean] => [r.role, isWriterRole(r)]),
  );
  // The tester holds patch.apply; keying on the name 'coder' is what left it unreviewed.
  assert.deepEqual(verdicts, { coder: true, tester: true, security: false, reviewer: false });
});

test('isWriterRole: every tool the default registry rates above read makes its holder a writer', () => {
  // So a tool added at write, dangerous or execute level cannot leave its holder unreviewed.
  for (const tool of createDefaultRegistry().getAll()) {
    assert.equal(isWriterRole(tools([tool.id])), tool.permissionLevel !== 'read', `${tool.id} (${tool.permissionLevel})`);
  }
});
