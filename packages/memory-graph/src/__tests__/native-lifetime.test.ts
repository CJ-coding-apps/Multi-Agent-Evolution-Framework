import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as kuzu from 'kuzu';
import type { Connection, Database, KuzuParameter, PreparedStatement, QueryResult } from 'kuzu';
import { makeRunId } from '@maf/types';
import { KuzuDriver } from '../KuzuDriver.js';
import { MemoryGraph } from '../MemoryGraph.js';

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
// the native writes and failed with `ENOTEMPTY`: 3 of 10 processes at 10 processes × 60 cycles,
// 0 of 600 run one at a time. `close()` now returns a promise that resolves only after the
// release; the four tests at the end of this file pin that, without wall-clock budgets.

const execFileAsync = promisify(execFile);
const ENTRY = path.resolve(__dirname, '../index.js');

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'maf-lifetime-'));
}

/** Drains the microtask and `setImmediate` queues: "let everything that can run, run". */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
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

test('four processes closing and removing graphs at once, thirty cycles each, leave no ENOTEMPTY', async () => {
  // The measurement that found the defect: 10 processes × 60 cycles failed in 3 of 10. Four
  // processes × 30 cycles is contended enough to have failed and small enough for CI. The child
  // removes its directory straight after an awaited `close()`, which is the race.
  const child = `
    const { MemoryGraph } = require(${JSON.stringify(ENTRY)});
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    (async () => {
      for (let i = 0; i < 30; i++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maf-contend-'));
        const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
        await graph.addNode({ kind: 'Task', label: 'cycle ' + i, properties: {}, runId: 'r' });
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
    `${failed.length} of 4 processes failed (ENOTEMPTY is the race this fixes)`,
  );
  for (const run of runs) assert.match(run.ok ? run.stdout : '', /cycles done/);
});
