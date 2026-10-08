import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolId } from '@maf/types';
import { isWriterRole } from '../isWriterRole.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';

// ORACLE: D-07 — the security gate applies to every role that holds a write tool. The predicate
// is the whole of that rule, so it is tested in both directions: a writer it misses goes
// unreviewed, and a reader it catches is made to need a repository it does not use.

const tools = (ids: string[]) => ({ allowedTools: ids.map((id) => makeToolId(id)) });

const TABLE: Array<{ name: string; allowedTools: string[]; writer: boolean }> = [
  { name: 'no tools',                    allowedTools: [],                                   writer: false },
  { name: 'every read tool',             allowedTools: ['fs.read', 'fs.list', 'fs.stat', 'grep', 'git.status', 'git.diff', 'git.log'], writer: false },
  { name: 'test.run alone',              allowedTools: ['test.run'],                         writer: false },
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
