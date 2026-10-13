import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { makeRunId } from '@maf/types';
import { KuzuDriver } from '../KuzuDriver.js';
import { MemoryGraph } from '../MemoryGraph.js';

// ORACLE (WP-2.15): CI's goldens-offline tests aborted on most runs with `malloc(): unsorted double
// linked list corrupted`. The driver never closed a kuzu QueryResult, whose rows live in its
// Database's buffer manager, so when a dropped graph was collected Node's finalizers freed the
// Database and then, in no fixed order, the results — writing into the freed buffer manager. And
// because `close()` released nothing, each graph kept an 8 TB address-space reservation for the
// life of the process: the ninth open in one process failed outright.

const execFileAsync = promisify(execFile);
const ENTRY = path.resolve(__dirname, '../index.js');

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'maf-lifetime-'));
}

test('twenty graphs opened, used and closed in turn in one process all work: close() returns the database', async () => {
  for (let i = 0; i < 20; i++) {
    const dir = await tempDir();
    try {
      const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
      await graph.addNode({ kind: 'Task', label: `graph ${i}`, properties: {}, runId: makeRunId(`lifetime-${i}`) });
      const rows = await graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN count(n) AS c', params: {} });
      assert.equal(Number(rows[0]?.['c']), 1, `graph ${i} holds the one node written to it`);
      graph.close();
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
      graph.close();
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
    driver.close();
    await inFlight; // its database was not freed under it
    await assert.rejects(
      () => driver.run({ cypher: 'MATCH (t:T) RETURN t.id AS id', params: {} }),
      /^Error: The graph at .*g\.kuzu is closed; a query was issued after close\(\)\.$/,
    );
    driver.close(); // a second close is a no-op

    const reopened = new KuzuDriver(file);
    try {
      assert.deepEqual(await reopened.run({ cypher: 'MATCH (t:T) RETURN t.id AS id', params: {} }), [{ id: 'kept' }]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphs closed while still initialising are released once that settles', async () => {
  const dir = await tempDir();
  try {
    // Twelve graphs closed with their schema creation in flight (release then waits for it, a few
    // ms). Were they never released, their reservations would leave the next graph none to take.
    for (let i = 0; i < 12; i++) {
      new MemoryGraph(path.join(dir, `early-${i}.kuzu`)).close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const graph = new MemoryGraph(path.join(dir, 'after.kuzu'));
    try {
      await graph.addNode({ kind: 'Task', label: 'after', properties: {}, runId: makeRunId('lifetime-init') });
      assert.deepEqual(await graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN n.label AS label', params: {} }), [{ label: 'after' }]);
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
