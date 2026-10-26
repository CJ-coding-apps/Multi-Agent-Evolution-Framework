import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as kuzu from 'kuzu';
import type { Connection, Database, KuzuModule, KuzuParameter, PreparedStatement, QueryResult } from 'kuzu';
import { makeRunId } from '@maf/types';
import type { GraphQuery } from '@maf/types';
import { KuzuDriver, kuzuVersion } from '../KuzuDriver.js';
import { MemoryGraph } from '../MemoryGraph.js';
import type { GraphDriver } from '../MemoryGraph.js';
import { GRAPH_EXPORT_FORMAT, GRAPH_EXPORT_FORMAT_VERSION } from '../GraphTransfer.js';
import type { GraphExport } from '../GraphTransfer.js';

// ORACLE (WP-2.15): CI's goldens-offline tests aborted on most runs with `malloc(): unsorted double
// linked list corrupted`. The driver never closed a kuzu QueryResult, whose rows live in its
// Database's buffer manager, so when a dropped graph was collected Node's finalizers freed the
// Database and then, in no fixed order, the results — writing into the freed buffer manager. And
// because `close()` released nothing, each graph kept an 8 TB address-space reservation for the
// life of the process: the ninth open in one process failed outright.
//
// ORACLE (WP-3.8 follow-up): the driver's `close()` was synchronous and returned at once. When
// anything was in flight — the connection's `init()` that every constructor starts, a query, a
// schema statement — the release was deferred, so a caller that removed the directory next raced
// the native writes. CI at `6beab28` (Kùzu 0.11.3) failed once with `ENOTEMPTY`; the verifier's
// attempts did not reproduce it on demand, and the base code at 10 × 60 on 0.7.1 never failed.
// `close()` now returns a promise that resolves only after the release. Tests 5–7 pin that by
// ordering, without wall-clock budgets; the four-process test is the M1 shape as a smoke test,
// because at 0.11.3 the race no longer has an observable symptom (see its comment).

const execFileAsync = promisify(execFile);
const ENTRY = path.resolve(__dirname, '../index.js');

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'maf-lifetime-'));
}

/** Drains the microtask and `setImmediate` queues: "let everything that can run, run". */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Waits for a condition that depends on native work, with a bound so a wrong path fails loudly. */
async function waitFor(predicate: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('twenty graphs opened, used and closed in turn in one process all work: close() returns the database', async () => {
  for (let i = 0; i < 20; i++) {
    const dir = await tempDir();
    try {
      const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
      await graph.addNode({ kind: 'Task', label: `graph ${i}`, properties: {}, runId: makeRunId(`lifetime-${i}`) });
      const rows = await graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN count(n) AS c', params: {} });
      assert.equal(Number(rows[0]?.['c']), 1, `graph ${i} holds the one node written to it`);
      await graph.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('graphs dropped and garbage-collected while the process runs on leave its heap intact', async () => {
  // In a child, so a corrupted heap fails this test with the signal instead of taking the runner
  // down. Each cycle is what one `goldens run` does to its evaluation graph, in a function of its
  // own so that the graph and its last results become garbage together — the case that crashed;
  // the collection and the turn of the loop after it let Node run the native finalizers.
  const child = `
    const { MemoryGraph } = require(${JSON.stringify(ENTRY)});
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    async function cycle() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maf-lifetime-gc-'));
      const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
      for (let k = 0; k < 20; k++) await graph.addNode({ kind: 'Task', label: 'task ' + k, properties: { k }, runId: 'r' });
      await graph.querySubgraph('task 1', 40);
      await graph.run({ cypher: 'MATCH (n:MemoryNode) DETACH DELETE n', params: {} });
      await graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    (async () => {
      for (let i = 0; i < 20; i++) {
        await cycle();
        global.gc();
        await new Promise((resolve) => setImmediate(resolve));
        for (let j = 0; j < 50; j++) fs.readdirSync(os.tmpdir());
      }
      console.log('survived 20');
    })();`;
  const { stdout } = await execFileAsync(process.execPath, ['--expose-gc', '-e', child], { timeout: 120_000 }).catch(
    (e: { code?: number; signal?: string; stderr?: string }) => assert.fail(
      `the process died (${e.signal ?? `exit ${String(e.code)}`}) after collecting a closed graph: ${e.stderr ?? ''}`,
    ),
  );
  assert.match(stdout, /survived 20/);
});

test('close() lets a query in flight finish, refuses one issued after it, and leaves the data on disk', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'g.kuzu');
    const driver = new KuzuDriver(file);
    await driver.run({ cypher: 'CREATE NODE TABLE T(id STRING, PRIMARY KEY(id))', params: {} });
    const inFlight = driver.run({ cypher: 'CREATE (:T {id: $id})', params: { id: 'kept' } });
    const closing = driver.close();
    await inFlight; // its database was not freed under it
    await closing;
    await assert.rejects(
      () => driver.run({ cypher: 'MATCH (t:T) RETURN t.id AS id', params: {} }),
      /^Error: The graph at .*g\.kuzu is closed; a query was issued after close\(\)\.$/,
    );
    assert.equal(driver.close(), closing, 'a second close hands back the same promise');

    const reopened = new KuzuDriver(file);
    try {
      assert.deepEqual(await reopened.run({ cypher: 'MATCH (t:T) RETURN t.id AS id', params: {} }), [{ id: 'kept' }]);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a graph opened and closed without a query runs no schema setup, so its directory goes at once (M1)', async () => {
  // F15. The constructor used to start the DDL sequence; a caller that failed right after
  // construction closed the graph while the sequence was between two statements, the driver
  // released the database, the next statement threw, and the caller's `rm` raced handles that
  // were not yet closed — `ENOTEMPTY … memory.kuzu`, measured at 1 in 20. Schema setup now starts
  // with the first query, so this close has nothing to wait for. Sixty clean removals is the
  // measured form of the verifier's 20-run loop; each `rm` follows an awaited `close()`.
  for (let i = 0; i < 60; i++) {
    const dir = await tempDir();
    try {
      await new MemoryGraph(path.join(dir, 'memory.kuzu')).close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// ── WP-3.8 follow-up: `close()` resolves only after the release ────────────────────────────────
//
// These four tests observe the ordering rather than a duration. Each patches one method of the
// kuzu JS classes and records what happened, so the assertion is "the release finished before the
// promise resolved" — a fact, not a deadline. The patch is restored in `finally` in every case.

/** Records the order in which the connection and the database are released. */
function instrumentReleases(events: string[]): { restore(): void } {
  const originalConn = kuzu.Connection.prototype.close;
  const originalDb   = kuzu.Database.prototype.close;
  kuzu.Connection.prototype.close = async function (this: Connection): Promise<void> {
    events.push('conn:begin');
    await new Promise<void>((resolve) => setImmediate(resolve)); // a real asynchronous gap
    await originalConn.call(this);
    events.push('conn:end');
  };
  kuzu.Database.prototype.close = async function (this: Database): Promise<void> {
    events.push('db:begin');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await originalDb.call(this);
    events.push('db:end');
  };
  return {
    restore() {
      kuzu.Connection.prototype.close = originalConn;
      kuzu.Database.prototype.close = originalDb;
    },
  };
}

test('close() resolves only after the connection and then the database have closed (kills the early-resolve mutant)', async () => {
  const dir = await tempDir();
  const events: string[] = [];
  const patch = instrumentReleases(events);
  try {
    const driver = new KuzuDriver(path.join(dir, 'ordered.kuzu'));
    await driver.run({ cypher: 'CREATE NODE TABLE T(id STRING, PRIMARY KEY(id))', params: {} });
    // A `close()` that resolved before the release — the old synchronous one, or a mutant that
    // resolves first and releases after — puts `close:resolved` before the two ends, or (for the
    // synchronous form, which returned `undefined`) throws here rather than reaching the assert.
    await driver.close().then(() => events.push('close:resolved'));
    assert.deepEqual(
      events,
      ['conn:begin', 'conn:end', 'db:begin', 'db:end', 'close:resolved'],
      'the promise resolved before the native handles were released',
    );
    // The consequence the ordering exists for: the directory goes, immediately.
    await rm(dir, { recursive: true, force: true });
  } finally {
    patch.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Holds `Connection.init()` open until `release()`, so "close during init" is deterministic. */
function holdInit(): { release(): void; restore(): void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = kuzu.Connection.prototype.init;
  kuzu.Connection.prototype.init = async function (this: Connection): Promise<void> {
    await original.call(this);
    await held;
  };
  return { release, restore() { kuzu.Connection.prototype.init = original; } };
}

test("close() during the connection's init() resolves only after the init and the release have finished", async () => {
  const dir = await tempDir();
  const hold = holdInit();
  try {
    const driver = new KuzuDriver(path.join(dir, 'during-init.kuzu'));
    let resolved = false;
    const closing = driver.close().then(() => { resolved = true; });
    await drain();
    // The constructor's `init()` is deliberately still in flight; `close()` must be waiting on it.
    // The synchronous close this replaces returned here, leaving the release to happen later.
    assert.equal(resolved, false, 'close resolved while init() was still in flight');

    hold.release();
    await closing;
    assert.equal(resolved, true);
    await rm(dir, { recursive: true, force: true }); // the directory goes once close has resolved
    assert.ok(driver, 'no unused-variable warning for the handle we are proving about');
  } finally {
    hold.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Holds the next `Connection.execute()` open until `release()`, so "close during a query" is deterministic. */
function holdNextExecute(): { release(): void; restore(): void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = kuzu.Connection.prototype.execute;
  let armed = true;
  kuzu.Connection.prototype.execute = async function (
    this: Connection,
    prepared: PreparedStatement,
    params?: Record<string, KuzuParameter>,
  ): Promise<QueryResult> {
    if (armed) {
      armed = false;
      await held;
    }
    return original.call(this, prepared, params);
  };
  return { release, restore() { kuzu.Connection.prototype.execute = original; } };
}

test('close() during a query waits for the query, then for the release, and the query\'s row is on disk', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'during-query.kuzu');
  try {
    const driver = new KuzuDriver(file);
    await driver.run({ cypher: 'CREATE NODE TABLE T(id STRING, PRIMARY KEY(id))', params: {} });
    const hold = holdNextExecute();
    try {
      const query = driver.run({ cypher: 'CREATE (:T {id: $id})', params: { id: 'finished' } });
      await drain();
      let resolved = false;
      const closing = driver.close().then(() => { resolved = true; });
      await drain();
      assert.equal(resolved, false, 'close resolved while a query was in flight');

      hold.release();
      await query;
      await closing;
      assert.equal(resolved, true);
    } finally {
      hold.restore();
    }

    // Reopened before the directory is removed, so this reads the same database rather than a new
    // one the constructor creates in the deleted directory's place.
    const reopened = new KuzuDriver(file);
    try {
      assert.deepEqual(
        await reopened.run({ cypher: 'MATCH (t:T) RETURN t.id AS id', params: {} }),
        [{ id: 'finished' }],
        'the query that was in flight when close() was called completed and was written',
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MemoryGraph.close() waits for a schema sequence that is between two statements, so no statement meets a closed database', async () => {
  // The driver's in-flight count passes through zero between two DDL statements. If `close()`
  // released on that count alone, the next statement would run against a closed connection —
  // which is why `MemoryGraph.close()` awaits `schemaReady` before it lets the driver go.
  const dir = await tempDir();
  const file = path.join(dir, 'schema-gap.kuzu');
  try {
    const graph = new MemoryGraph(file);
    const hold = holdNextExecute();
    try {
      const write = graph.addNode({ kind: 'Task', label: 'during schema setup', properties: {}, runId: makeRunId('schema-gap') });
      await drain(); // the first DDL statement is now held, so the sequence is mid-flight
      const closing = graph.close();
      hold.release();
      await write;   // every remaining DDL statement and the insert completed
      await closing; // and only then did the release run
    } finally {
      hold.restore();
    }

    // Reopened before the directory is removed, so this reads the database that was written.
    const reopened = new MemoryGraph(file);
    try {
      const rows = await reopened.run({ cypher: 'MATCH (n:MemoryNode) RETURN n.label AS label', params: {} });
      assert.deepEqual(rows.map((r) => r['label']), ['during schema setup']);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── WP-3.8 follow-up round 2: `MemoryGraph` counts its own work ────────────────────────────────
//
// The driver's count cannot see a query that has passed the `closed` check but is still awaiting
// schema setup, and it cannot see the mapping work after the last driver call. Both are the
// caller's own work, so `MemoryGraph` counts them. These tests hold one statement of a real
// operation open and close in the middle of it.

/** Wraps a driver, holding the first `run` whose query `matches` until `release()` is called. */
function holdQuery(inner: GraphDriver, matches: (query: GraphQuery) => boolean): {
  release(): void;
  entered(): boolean;
  driver: GraphDriver;
} {
  let release!: () => void;
  let armed = true;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    entered: () => !armed,
    driver: {
      run(query: GraphQuery) {
        if (armed && matches(query)) {
          armed = false;
          return held.then(() => inner.run(query));
        }
        return inner.run(query);
      },
      close: () => inner.close(),
    },
  };
}

test('MemoryGraph.close() lets a query issued just before it finish with its real rows, and refuses the next one (C2)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'run-then-close.kuzu');
  try {
    const graph = new MemoryGraph(file);
    await graph.addNode({ kind: 'Task', label: 'already written', properties: {}, runId: makeRunId('c2-run') });

    // Schema setup is done, so this query is past the `closed` check and waiting on the driver's
    // `run` when `close()` runs. A close that waited only on the driver released the database
    // here, and the query was refused instead of returning its row.
    const query = graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN n.label AS label', params: {} });
    const closing = graph.close();
    assert.deepEqual(
      await query,
      [{ label: 'already written' }],
      'the query issued before close() completed and returned the real rows',
    );
    await closing;

    // A call made after `close()` is still refused at once.
    await assert.rejects(
      () => graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN n', params: {} }),
      /This memory graph is closed; a query was issued after close\(\)\./,
    );
    await assert.rejects(
      () => graph.addNode({ kind: 'Task', label: 'after close', properties: {}, runId: makeRunId('c2-after') }),
      /This memory graph is closed; a query was issued after close\(\)\./,
    );
    assert.equal(graph.close(), closing, 'a second close hands back the same promise');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MemoryGraph.close() waits for a querySubgraph between its node and edge queries, so the edges are real (C2)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'subgraph.kuzu');
  try {
    const inner = new KuzuDriver(file);
    const held = holdQuery(inner, (q) => q.cypher.includes('MATCH (a:MemoryNode)-[e:MemoryEdge]'));
    const graph = new MemoryGraph(file, undefined, held.driver);
    try {
      const from = await graph.addNode({ kind: 'Task', label: 'alpha one', properties: {}, runId: makeRunId('c2-edge') });
      const to   = await graph.addNode({ kind: 'Task', label: 'alpha two', properties: {}, runId: makeRunId('c2-edge') });
      await graph.addEdge({ fromId: from, toId: to, relation: 'DEPENDS_ON', weight: 1, metadata: {} });

      const subgraph = graph.querySubgraph('alpha', 10);
      await waitFor(() => held.entered(), 'the edge query to be issued');

      const closing = graph.close();
      await drain(); // let close() reach its wait, so the release cannot be what the query waits on
      held.release();
      const result = await subgraph;
      assert.equal(result.nodes.length, 2, 'both nodes were found before close()');
      assert.equal(result.edges.length, 1, 'the edge query issued before close() returned its edge, not 0');
      await closing;
    } finally {
      held.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── WP-3.8 follow-up round 2: a failed release is not a successful one (C4) ────────────────────

test('a native database close that throws rejects close(), and the connection is still released first (C4)', async () => {
  const dir = await tempDir();
  const events: string[] = [];
  const originalConn = kuzu.Connection.prototype.close;
  const originalDb   = kuzu.Database.prototype.close;
  kuzu.Connection.prototype.close = async function (this: Connection): Promise<void> {
    events.push('connection');
    await originalConn.call(this);
  };
  // The throw stands in for a native failure (a checkpoint that fails); the underlying close is
  // still run so the test process does not carry an unclosed database into the next test.
  kuzu.Database.prototype.close = async function (this: Database): Promise<void> {
    events.push('database');
    await originalDb.call(this);
    throw new Error('checkpoint failed');
  };
  try {
    const driver = new KuzuDriver(path.join(dir, 'failed-close.kuzu'));
    await driver.run({ cypher: 'CREATE NODE TABLE T(id STRING, PRIMARY KEY(id))', params: {} });
    await assert.rejects(
      () => driver.close(),
      /^Error: The graph at .*failed-close\.kuzu was not released: kuzu's database close failed: checkpoint failed$/,
    );
    assert.deepEqual(events, ['connection', 'database'], 'the connection is released before the database even when the database close fails');
  } finally {
    kuzu.Connection.prototype.close = originalConn;
    kuzu.Database.prototype.close = originalDb;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a connection whose init() failed still releases in order, and close() resolves (C4)', async () => {
  const dir = await tempDir();
  const events: string[] = [];
  const originalInit = kuzu.Connection.prototype.init;
  const originalConn = kuzu.Connection.prototype.close;
  const originalDb   = kuzu.Database.prototype.close;
  kuzu.Connection.prototype.init = async function (): Promise<void> {
    throw new Error('init refused');
  };
  kuzu.Connection.prototype.close = async function (this: Connection): Promise<void> {
    events.push('connection');
    await originalConn.call(this);
  };
  kuzu.Database.prototype.close = async function (this: Database): Promise<void> {
    events.push('database');
    await originalDb.call(this);
  };
  try {
    const driver = new KuzuDriver(path.join(dir, 'failed-init.kuzu'));
    await assert.rejects(
      () => driver.run({ cypher: 'RETURN 1 AS one', params: {} }),
      /init refused/,
      'the failure is delivered through ready to the caller that awaited it',
    );
    // Nothing native was initialised, so there is nothing left to report: close() resolves, and
    // the connection is still attempted before the database rather than abandoned behind it.
    await driver.close();
    assert.deepEqual(events, ['connection', 'database']);
  } finally {
    kuzu.Connection.prototype.init  = originalInit;
    kuzu.Connection.prototype.close = originalConn;
    kuzu.Database.prototype.close   = originalDb;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── WP-3.8 follow-up round 3: the HIGH, and operations that finish across close() ──────────────

test('release() does not free the database when conn.close() throws after a failed init (R2-2)', async () => {
  // `release()`'s path (b), which has no other way to be reached: the database opened, then only
  // the connection's `Connection.init()` rejected. A later `Connection.close()` re-awaits the
  // connection's retained rejected init promise and throws *before* it releases the native
  // connection (`kuzu@0.11.3 connection.js:425-445`). The database is natively open, so freeing it
  // under a connection that still points into its buffer manager is a use-after-free; `release()`
  // must skip `db.close()` — a leaked handle is the lesser evil — and still resolve, because the
  // one real error was already delivered through `ready`. A fake module is injected so the throw is
  // deterministic and no real native handle leaks. Removing the `connClosed` guard in `release()`
  // turns the `dbCloseCalls === 0` assertion red.
  let dbCloseCalls = 0;
  let connCloseCalls = 0;
  const fakeModule = {
    VERSION: '0.11.3-fake',
    Database: class { constructor(_p?: string, _b?: number) { /* no native handle */ } async close(): Promise<void> { dbCloseCalls++; } },
    Connection: class {
      constructor(_db: unknown) { /* no native handle */ }
      async init(): Promise<void> { throw new Error('init refused'); }
      async close(): Promise<void> { connCloseCalls++; throw new Error('connection close after failed init'); }
    },
  } as unknown as KuzuModule;

  const driver = new KuzuDriver(':memory:', undefined, fakeModule);
  // The init failure is delivered to the query that awaits it, exactly as a real open failure is.
  await assert.rejects(() => driver.run({ cypher: 'RETURN 1 AS one', params: {} }), /init refused/);
  // close() resolves rather than rejecting: path (b) — the connection's init failed, conn.close()
  // threw before releasing it, and db.close() was deliberately skipped. The natively open database
  // is leaked to the GC rather than freed under the connection; that is still the error path.
  await driver.close();
  assert.equal(connCloseCalls, 1, 'the connection close was attempted');
  assert.equal(dbCloseCalls, 0, 'the database was NOT freed under a connection that did not release');
  // A second close hands back the same resolved promise, and still never calls db.close().
  await driver.close();
  assert.equal(dbCloseCalls, 0, 'a second close did not free the database either');
});

test('MemoryGraph.close() lets an in-flight mergeRuns finish rather than refusing it halfway (R2-1)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'merge-close.kuzu');
  try {
    const inner = new KuzuDriver(file);
    // Hold mergeRuns' first source query, so `close()` lands before the merge has written anything.
    // The two setup writes below are `CREATE`s, so this matcher is not tripped by them.
    const held = holdQuery(inner, (q) => q.cypher.includes('{run_id: $runId}) RETURN n LIMIT'));
    const graph = new MemoryGraph(file, undefined, held.driver);
    try {
      await graph.addNode({ kind: 'Task', label: 'first',  properties: {}, runId: makeRunId('src') });
      await graph.addNode({ kind: 'Task', label: 'second', properties: {}, runId: makeRunId('src') });

      const merging = graph.mergeRuns([makeRunId('src')], makeRunId('tgt'));
      await waitFor(() => held.entered(), 'mergeRuns to reach its first source query');

      const closing = graph.close();
      await drain(); // let close() reach its wait on `inFlight`; mergeRuns is counted, so it waits
      held.release();

      // The merge finished with its full report rather than being refused mid-way with
      // "graph is closed" — which is what the public `addNode`/`addEdge` path would have done.
      const report = await merging;
      assert.equal(report.conflictsFound.length, 0, 'no conflicts');
      assert.ok(report.nodesCreated >= 3, `the merge wrote its nodes (got ${report.nodesCreated})`);
      await closing;
    } finally {
      held.release();
    }

    const reopened = new MemoryGraph(file);
    try {
      const rows = await reopened.run({ cypher: `MATCH (n:MemoryNode {run_id: 'tgt'}) RETURN count(n) AS c`, params: {} });
      assert.ok(Number(rows[0]?.['c']) >= 3, 'the merged nodes were written under the target run');
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MemoryGraph.close() lets an in-flight importGraph finish its transaction rather than refusing it halfway (R2-1)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'import-close.kuzu');
  try {
    const inner = new KuzuDriver(file);
    // Hold the first node insert of the import, so `close()` lands mid-transaction.
    const held = holdQuery(inner, (q) => q.cypher.includes('CREATE (:MemoryNode {id: $id'));
    const graph = new MemoryGraph(file, undefined, held.driver);
    const exported: GraphExport = {
      format: GRAPH_EXPORT_FORMAT,
      formatVersion: GRAPH_EXPORT_FORMAT_VERSION,
      kuzuVersion: 'test',
      exportedAt: '2020-01-01T00:00:00.000Z',
      nodes: [
        { id: 'n1', kind: 'Task', label: 'one', properties: {}, runId: 'r', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
        { id: 'n2', kind: 'Task', label: 'two', properties: {}, runId: 'r', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
      ],
      edges: [
        { id: 'e1', fromId: 'n1', toId: 'n2', relation: 'DEPENDS_ON', weight: 1, metadata: {}, createdAt: '2020-01-01T00:00:00.000Z' },
      ],
    };
    try {
      const importing = graph.importGraph(exported);
      await waitFor(() => held.entered(), 'the import to reach its first node insert');

      const closing = graph.close();
      await drain();
      held.release();

      // The whole import — the remaining inserts, COMMIT, and the final count check — ran across
      // the close rather than being refused mid-transaction.
      const report = await importing;
      assert.deepEqual(report, { nodesCreated: exported.nodes.length, edgesCreated: exported.edges.length });
      await closing;
    } finally {
      held.release();
    }

    const reopened = new MemoryGraph(file);
    try {
      const rows = await reopened.run({ cypher: `MATCH (n:MemoryNode) RETURN count(n) AS c`, params: {} });
      assert.equal(Number(rows[0]?.['c']), 2, 'the imported nodes were committed');
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MemoryGraph.close() lets an in-flight exportGraph return the full export rather than refusing it halfway (R3-4)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'export-close.kuzu');
  try {
    const inner = new KuzuDriver(file);
    // Hold the export's node query, so `close()` lands after the nodes have been read and before
    // the edge query starts. Routing the export through the closed-checked `run` turns the edge
    // assertion red: the second query is refused once `close()` has set the flag.
    const held = holdQuery(inner, (q) => q.cypher.includes('MATCH (n:MemoryNode)'));
    const graph = new MemoryGraph(file, undefined, held.driver);
    try {
      const from = await graph.addNode({ kind: 'Task', label: 'from', properties: {}, runId: makeRunId('export') });
      const to   = await graph.addNode({ kind: 'Task', label: 'to',   properties: {}, runId: makeRunId('export') });
      await graph.addEdge({ fromId: from, toId: to, relation: 'DEPENDS_ON', weight: 1, metadata: {} });

      const exporting = graph.exportGraph(kuzuVersion());
      await waitFor(() => held.entered(), 'the export to reach its node query');

      const closing = graph.close();
      await drain();
      held.release();

      // The whole export — the edge query after the held node query, the row checks and the
      // returned object — ran across the close rather than being refused halfway.
      const exported = await exporting;
      assert.deepEqual(
        exported.nodes.map((n) => n.label).sort(),
        ['from', 'to'],
        'the export read every node',
      );
      assert.equal(exported.edges.length, 1, 'the export read the edge after the close');
      assert.equal(exported.edges[0]?.fromId, from);
      assert.equal(exported.edges[0]?.toId, to);
      await closing;
    } finally {
      held.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('four processes closing and removing graphs at once, thirty cycles each, leave no ENOTEMPTY', async () => {
  // The shape that raced: open → close → rm with **no query**, so the connection's `init()` is
  // still in flight when `close()` is called. The earlier form wrote a node first, which settled
  // `init()` and left nothing in flight — it passed on the old code, so it could not pin anything.
  //
  // Measured on base `60e93e5` with Kùzu 0.11.3: it **passes**, on macOS and on Linux (the logs
  // are in the PR body). CI at `6beab28` (kuzu 0.11.3, run 39832249760) failed once with
  // `ENOTEMPTY`; neither 0.11.3 nor this reshaped test has reproduced it on demand on macOS or
  // Linux, and `close()` now resolves only after both native closes, which removes the window by
  // construction. In the verifier's ten runs, with `close()` mutated to resolve early this 4 × 30
  // test failed 2 of 10 and unmutated it failed 0 of 10; this session's ten runs of each, on macOS
  // and Linux, failed 0 of 10 in both — it is a race, not a guaranteed red. So it can go red when
  // the release returns early: "cannot go red" is not a property of the test. The base code at
  // 10 × 60 on 0.7.1 never failed. It is still a smoke test of the M1 shape rather than a
  // regression pin, because on the unmutated 0.11.3 build the race has no observable symptom. It
  // targets 0.11.3, whose single-file database removes the case the race depended on — the release
  // re-creating a directory entry after `rm` had emptied the directory. The regression itself is
  // pinned by tests 5–7, which fail on an early-resolving `close()`.
  const child = `
    const { MemoryGraph } = require(${JSON.stringify(ENTRY)});
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    (async () => {
      for (let i = 0; i < 30; i++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maf-contend-'));
        const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
        await graph.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
      console.log('cycles done');
    })();`;
  const runs = await Promise.all([0, 1, 2, 3].map(() =>
    execFileAsync(process.execPath, ['-e', child], { timeout: 300_000 }).then(
      (ok) => ({ ok: true as const, ...ok }),
      (err: { stderr?: string; code?: number }) => ({ ok: false as const, stderr: err.stderr ?? '', code: err.code }),
    )));
  const failed = runs.filter((r) => !r.ok);
  assert.deepEqual(
    failed.map((r) => r.stderr),
    [],
    `${failed.length} of 4 processes failed while closing and removing graphs`,
  );
  for (const run of runs) assert.match(run.ok ? run.stdout : '', /cycles done/);
});
