import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphQuery, GraphRow } from '@maf/types';
import { MemoryGraph, type GraphDriver } from '../MemoryGraph.js';
import { SCHEMA_DDL } from '../schema.js';

// ORACLE (WP-3.8, F2). `initSchema()` used to swallow every error with a comment about
// "already exists", so a read-only file, a full disk or an unopenable database produced a graph
// that accepted no writes and silently read back nothing. The fix tolerates `/already exists/i`
// and rethrows everything else — and the only place that distinction is observable is a driver
// whose DDL rejects. These tests supply one, because a real Kùzu cannot be asked to fail on cue.
//
// The swallow-all mutant must die here: restore `catch { continue }` and the first test fails.

const DDL = SCHEMA_DDL.split(';').map((s) => s.trim()).filter(Boolean);

/** A driver that answers queries with `[{ c: 0 }]` and records the DDL it was asked to run. */
function fakeDriver(rejectDdl: (index: number) => Error | undefined): GraphDriver & { ddl: string[] } {
  const ddl: string[] = [];
  return {
    ddl,
    close(): void { /* nothing native to release */ },
    async run(query: GraphQuery): Promise<GraphRow[]> {
      if (!query.cypher.startsWith('CREATE')) return [{ c: 0 }];
      const index = ddl.length;
      ddl.push(query.cypher);
      const failure = rejectDdl(index);
      if (failure) throw failure;
      return [];
    },
  };
}

const COUNT_QUERY: GraphQuery = { cypher: 'MATCH (n:MemoryNode) RETURN count(n) AS c', params: {} };

test('a schema statement that fails for any reason but "already exists" reaches the caller', async () => {
  const failure = new Error('IO exception: could not write to /x/memory.kuzu (disk full)');
  const driver = fakeDriver((index) => (index === 0 ? failure : undefined));
  const graph = new MemoryGraph(':memory:', 128 * 1024 * 1024, driver);

  // `run()` is the query path: it awaits setup, so the DDL failure is what it rejects with.
  await assert.rejects(() => graph.run(COUNT_QUERY), (err: unknown) => {
    assert.equal(err, failure, 'the driver\'s own error, not a rewritten one');
    return true;
  });
  assert.deepEqual(driver.ddl, [DDL[0]], 'the sequence stopped at the failing statement');
});

test('"already exists" is tolerated: the rest of the schema runs and the query is answered', async () => {
  const driver = fakeDriver((index) => (index === 0 ? new Error('Catalog entry "MemoryNode" already exists') : undefined));
  const graph = new MemoryGraph(':memory:', 128 * 1024 * 1024, driver);

  assert.deepEqual(await graph.run(COUNT_QUERY), [{ c: 0 }]);
  assert.equal(driver.ddl.length, DDL.length, 'every schema statement was attempted');
});

test('setup starts once: a second query runs no DDL', async () => {
  const driver = fakeDriver(() => undefined);
  const graph = new MemoryGraph(':memory:', 128 * 1024 * 1024, driver);

  await graph.run(COUNT_QUERY);
  await graph.run(COUNT_QUERY);
  assert.equal(driver.ddl.length, DDL.length, 'one pass over the schema, not one per query');
});
