import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GraphQuery, GraphQueryRunner, GraphRow } from '@maf/types';
import { makeRunId } from '@maf/types';
import { MemoryGraph, recallFailures } from '../MemoryGraph.js';
import { GraphOpenError, kuzuVersion } from '../KuzuDriver.js';
import {
  exportGraph, importGraph, parseGraphExport, GraphTransferError,
  GRAPH_EXPORT_FORMAT, type GraphExport,
} from '../GraphTransfer.js';

// ORACLE (WP-3.8, D-58). Kùzu changed its on-disk format before 1.0: 0.7.1 wrote a directory and
// 0.11.3 writes one file and cannot read the old shape. The migration is an export/import, so what
// these tests pin is the artifact and its consumers, not the compatibility claim:
//   - the committed export was written by the real `maf graph export` while the repo was on
//     Kùzu 0.7.1 (fixtures/kuzu-0.7.1-export.json), and it must import here and answer the
//     planner's failure recall with its own rows;
//   - fixtures/kuzu-0.7.1.tar.gz is a checked-in 0.7.1 database, and opening it must refuse with
//     the export/import route rather than a binder message about a corrupt file;
//   - an import is either complete or absent, and a non-empty target is refused before any write.

const execFileAsync = promisify(execFile);
// The tests run from `dist/__tests__`, and `tsc` does not copy the fixture files, so the fixture
// directory is read from the source tree (the same arrangement attestation's bundle test uses).
const FIXTURES = path.resolve(__dirname, '..', '..', 'src', '__tests__', 'fixtures');
const KUZU_071_EXPORT = path.join(FIXTURES, 'kuzu-0.7.1-export.json');
const KUZU_071_TARBALL = path.join(FIXTURES, 'kuzu-0.7.1.tar.gz');

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function count(graph: GraphQueryRunner): Promise<{ nodes: number; edges: number }> {
  const [n] = await graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN count(n) AS c', params: {} });
  const [e] = await graph.run({ cypher: 'MATCH ()-[e:MemoryEdge]->() RETURN count(e) AS c', params: {} });
  return { nodes: Number(n?.['c'] ?? -1), edges: Number(e?.['c'] ?? -1) };
}

function fixtureExport(): GraphExport {
  return parseGraphExport(readFileSync(KUZU_071_EXPORT, 'utf8'), 'kuzu-0.7.1-export.json');
}

test('export then import into a fresh graph preserves every node, edge and property', async () => {
  const dir = await tempDir('maf-transfer-');
  try {
    const runId = makeRunId('run-transfer');
    const source = path.join(dir, 'source.kuzu');
    const target = path.join(dir, 'target.kuzu');
    let exported: GraphExport;
    {
      const graph = new MemoryGraph(source);
      try {
        const task = await graph.addNode({
          kind: 'Task', label: 'Add a token bucket', properties: { nodeId: 'n1', runTitle: 'Throttle login' }, runId,
        });
        const failure = await graph.addNode({
          kind: 'Failure', label: 'n1', properties: { nodeId: 'n1', reason: 'adapter_failed', exitCode: 1 }, runId,
        });
        const file = await graph.addNode({ kind: 'File', label: 'src/auth/login.ts', properties: {}, runId });
        await graph.addEdge({ fromId: task, toId: failure, relation: 'CAUSED_FAILURE', weight: 0.5, metadata: { note: 'one' } });
        await graph.addEdge({ fromId: task, toId: file, relation: 'MODIFIED', weight: 1, metadata: {} });
        exported = await exportGraph(graph, kuzuVersion());
        // The same graph always produces the same rows, so two runs cannot disagree on a diff.
        const twice = await exportGraph(graph, kuzuVersion());
        assert.deepEqual({ nodes: twice.nodes, edges: twice.edges }, { nodes: exported.nodes, edges: exported.edges });
      } finally {
        graph.close();
      }
    }
    assert.equal(exported.format, GRAPH_EXPORT_FORMAT);
    assert.equal(exported.formatVersion, 1);
    assert.equal(exported.nodes.length, 3);
    assert.equal(exported.edges.length, 2);

    {
      const graph = new MemoryGraph(target);
      try {
        assert.deepEqual(await importGraph(graph, exported), { nodesCreated: 3, edgesCreated: 2 });
      } finally {
        graph.close();
      }
    }

    const graph = new MemoryGraph(target);
    try {
      const again = await exportGraph(graph, kuzuVersion());
      assert.deepEqual(
        { nodes: again.nodes, edges: again.edges },
        { nodes: exported.nodes, edges: exported.edges },
        'a round trip through the JSON changes no node, edge, property or timestamp',
      );
      const recalled = await recallFailures(graph, { title: 'Add a token bucket', limit: 5 });
      assert.deepEqual(recalled.map((f) => [f.nodeId, f.reason, f.runId]), [['n1', 'adapter_failed', runId]]);
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an export written by Kùzu 0.7.1 imports into 0.11.3 and the planner's failure recall returns the same rows", async () => {
  const dir = await tempDir('maf-transfer-v071-');
  try {
    const text = await readFile(KUZU_071_EXPORT, 'utf8');
    const exported = parseGraphExport(text, 'kuzu-0.7.1-export.json');
    assert.equal(exported.kuzuVersion, '0.7.1');
    assert.deepEqual(
      { nodes: exported.nodes.length, edges: exported.edges.length },
      { nodes: 4, edges: 3 },
    );

    const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
    try {
      assert.notEqual(kuzuVersion(), '0.7.1', 'this test is only meaningful once the repo is on the newer Kùzu');
      assert.deepEqual(await importGraph(graph, exported), { nodesCreated: 4, edgesCreated: 3 });

      const expected = [{
        task:       'Add rate limiting to the login endpoint',
        role:       'coder',
        reason:     'adapter_failed',
        message:    'claude exited 1: not logged in',
        nodeId:     'n1',
        runId:      'run-2026-09-30-lcm',
        recordedAt: '2026-09-30T12:00:00.000Z',
      }];
      assert.deepEqual(await recallFailures(graph, { title: 'Add rate limiting to the login endpoint', limit: 10 }), expected);
      assert.deepEqual(await recallFailures(graph, { path: 'src/auth/login.ts', limit: 10 }), expected);

      const again = await exportGraph(graph, kuzuVersion());
      assert.deepEqual(
        { nodes: again.nodes, edges: again.edges },
        { nodes: exported.nodes, edges: exported.edges },
        'the 0.7.1 rows are restored byte-for-byte as plain JSON',
      );
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('import refuses a graph that already holds nodes, naming the count and --db', async () => {
  const dir = await tempDir('maf-transfer-nonempty-');
  try {
    const exported = fixtureExport();
    const graph = new MemoryGraph(path.join(dir, 'g.kuzu'));
    try {
      await graph.addNode({ kind: 'Run', label: 'already here', properties: {}, runId: makeRunId('existing') });
      await assert.rejects(
        () => importGraph(graph, exported),
        (err: unknown) => {
          assert.ok(err instanceof GraphTransferError, `expected a GraphTransferError, got ${String(err)}`);
          assert.match(err.message, /already holds 1 node/);
          assert.match(err.message, /--db/);
          return true;
        },
      );
      assert.deepEqual(await count(graph), { nodes: 1, edges: 0 }, 'a refused import wrote nothing');
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parse refuses a file it cannot import, naming the row and the reason', () => {
  const valid = fixtureExport();
  const text = (value: unknown): string => JSON.stringify(value);
  const cases: Array<[string, string, RegExp]> = [
    ['not JSON', '{ nope', /is not valid JSON/],
    ['not a maf export', text({ ...valid, format: 'something-else' }), /is not a maf graph export/],
    ['a newer format', text({ ...valid, formatVersion: 2 }), /Upgrade maf/],
    ['no format version', text({ ...valid, formatVersion: 0 }), /no valid formatVersion/],
    ['duplicate node id', text({ ...valid, nodes: [valid.nodes[0], valid.nodes[0]] }), /node id "fail-1" appears twice/],
    ['an edge to a missing node', text({ ...valid, nodes: valid.nodes.filter((n) => n.id !== 'fail-1') }), /missing node "fail-1"/],
    ['a non-finite weight', text({ ...valid, edges: [{ ...valid.edges[0], weight: '1' }] }), /weight must be a finite number/],
    ['an empty id', text({ ...valid, nodes: [{ ...valid.nodes[0], id: '' }] }), /nodes\[0\]\.id must be a non-empty string/],
  ];
  for (const [name, input, pattern] of cases) {
    assert.throws(() => parseGraphExport(input, 'the-file.json'), pattern, name);
  }
});

test('parse refuses an export naming a prototype key as what it is (G5)', () => {
  const valid = fixtureExport();
  // An own `__proto__` survives JSON.stringify, so the file on disk can carry one even though the
  // importer's own writer never would. The reviver refuses the document whole.
  const poisoned = JSON.stringify({
    ...valid,
    nodes: [{ ...valid.nodes[0], properties: JSON.parse('{"__proto__":{"polluted":true}}') }],
  });
  assert.match(poisoned, /"__proto__"/, 'the fixture actually carries the key');
  assert.throws(
    () => parseGraphExport(poisoned, 'poisoned.json'),
    (err: unknown) => {
      assert.ok(err instanceof GraphTransferError, `expected a GraphTransferError, got ${String(err)}`);
      assert.match(err.message, /^poisoned\.json is refused: the JSON key "__proto__" names a prototype/);
      assert.doesNotMatch(err.message, /is not valid JSON/, 'it parses; naming a prototype is the objection');
      return true;
    },
  );
  // Depth does not matter: a key inside an edge's metadata is refused by the same reviver.
  const deep = JSON.stringify({
    ...valid,
    edges: [{ ...valid.edges[0], metadata: { nested: JSON.parse('{"constructor":{}}') } }],
  });
  assert.throws(
    () => parseGraphExport(deep, 'deep.json'),
    /deep\.json is refused: the JSON key "constructor" names a prototype/,
  );
});

test('import refuses an edge to a node that is not in the file, and writes nothing', async () => {
  const dir = await tempDir('maf-transfer-ghost-');
  try {
    const graph = new MemoryGraph(path.join(dir, 'g.kuzu'));
    try {
      const node = fixtureExport().nodes.find((n) => n.id === 'task-1')!;
      const exported: GraphExport = {
        format: GRAPH_EXPORT_FORMAT, formatVersion: 1, kuzuVersion: '0.7.1', exportedAt: '',
        nodes: [node],
        edges: [{ id: 'e1', fromId: 'task-1', toId: 'ghost', relation: 'MODIFIED', weight: 1, metadata: {}, createdAt: '2026-09-30T12:00:00.000Z' }],
      };
      await assert.rejects(() => importGraph(graph, exported), /ends at missing node "ghost"/);
      assert.deepEqual(await count(graph), { nodes: 0, edges: 0 });
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an import that fails halfway rolls back, and the graph is usable afterwards', async () => {
  const dir = await tempDir('maf-transfer-rollback-');
  try {
    const graph = new MemoryGraph(path.join(dir, 'g.kuzu'));
    try {
      // A real write failure inside the transaction: the second edge write is refused after the
      // nodes and the first edge have been written. Only ROLLBACK can leave the target empty.
      const failing: GraphQueryRunner = {
        run: (query: GraphQuery): Promise<GraphRow[]> => query.params['id'] === 'edge-2'
          ? Promise.reject(new Error('simulated write failure'))
          : graph.run(query),
      };
      await assert.rejects(() => importGraph(failing, fixtureExport()), /simulated write failure/);
      assert.deepEqual(await count(graph), { nodes: 0, edges: 0 }, 'the committed part of the import is gone');

      // The rollback left no transaction open: an ordinary write still works.
      await graph.addNode({ kind: 'Run', label: 'after rollback', properties: {}, runId: makeRunId('after-rollback') });
      assert.deepEqual(await count(graph), { nodes: 1, edges: 0 });
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('opening a Kùzu 0.7.1 directory refuses it, names the path, and gives the one command that keeps it', async () => {
  const dir = await tempDir('maf-transfer-old-');
  try {
    await execFileAsync('tar', ['-xzf', KUZU_071_TARBALL, '-C', dir]);
    const old = path.join(dir, 'memory.kuzu');
    assert.ok((await stat(old)).isDirectory(), 'the fixture is a 0.7.x directory database');

    await assert.rejects(
      async () => {
        const graph = new MemoryGraph(old);
        try {
          await graph.run({ cypher: 'MATCH (n:MemoryNode) RETURN count(n) AS c', params: {} });
        } finally {
          graph.close();
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof GraphOpenError, `expected a GraphOpenError, got ${String(err)}`);
        assert.match(err.message, /0\.7\.x/);
        assert.ok(err.message.includes(`The graph at ${old} `), `the refusal names the path: ${err.message}`);
        assert.match(err.message, /recall\s+history/, 'it says what the graph held');
        assert.match(err.message, /code, branches\s+and attestations live elsewhere/, 'and what it did not');
        assert.match(err.message, /starts empty/, 'the fresh graph is stated, not implied');
        assert.ok(
          err.message.includes(`mv ${old} ${old}.0.7-backup`),
          `the one command names this path: ${err.message}`,
        );
        assert.match(err.message, /does not move or delete it for you/, 'maf does not act on the user\'s file');
        // The route this replaced was one no installed maf could carry out: no released version
        // has `graph export`, and this Kùzu cannot read the format it would have to export.
        assert.doesNotMatch(err.message, /maf graph export/);
        assert.doesNotMatch(err.message, /maf graph import/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export refuses a row the importer would refuse, naming the row and the field', async () => {
  const dir = await tempDir('maf-transfer-export-invariant-');
  try {
    // An empty runId: the import's `requiredString` rejects it, so the export must not write it.
    const emptyRun = new MemoryGraph(path.join(dir, 'a.kuzu'));
    try {
      await emptyRun.addNode({ kind: 'Task', label: 'no run', properties: {}, runId: makeRunId('') });
      await assert.rejects(
        () => exportGraph(emptyRun, kuzuVersion()),
        (err: unknown) => {
          assert.ok(err instanceof GraphTransferError, `expected a GraphTransferError, got ${String(err)}`);
          assert.match(err.message, /^Cannot export node 0 \(MemoryNode ".+"\): runId is empty\./);
          assert.match(err.message, /would be unreadable/);
          return true;
        },
      );
    } finally {
      emptyRun.close();
    }

    // A non-finite weight: the same rule on the edge side.
    const badWeight = new MemoryGraph(path.join(dir, 'b.kuzu'));
    try {
      const from = await badWeight.addNode({ kind: 'Task', label: 'from', properties: {}, runId: makeRunId('r1') });
      const to = await badWeight.addNode({ kind: 'Task', label: 'to', properties: {}, runId: makeRunId('r1') });
      await badWeight.addEdge({ fromId: from, toId: to, relation: 'DEPENDS_ON', weight: Number.NaN, metadata: {} });
      await assert.rejects(
        () => exportGraph(badWeight, kuzuVersion()),
        (err: unknown) => {
          assert.ok(err instanceof GraphTransferError, `expected a GraphTransferError, got ${String(err)}`);
          assert.match(err.message, /^Cannot export edge 0 \(MemoryEdge ".+"\): weight is NaN, not a finite number\./);
          return true;
        },
      );
    } finally {
      badWeight.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export refuses a stored blob naming a prototype key rather than carrying it into the file (G5)', async () => {
  const dir = await tempDir('maf-transfer-proto-');
  try {
    const graph = new MemoryGraph(path.join(dir, 'g.kuzu'));
    try {
      // A row written by an older reader (or by hand) can hold the key; the export reads every
      // stored blob through the shared reviver, so it refuses instead of writing it back out.
      await graph.run({
        cypher: `CREATE (:MemoryNode {id: 'poisoned', kind: 'Task', label: 'poisoned',
                  properties: '{"__proto__":{"polluted":true}}',
                  run_id: 'r', created_at: '2026-09-30T12:00:00.000Z', updated_at: '2026-09-30T12:00:00.000Z'})`,
        params: {},
      });
      await assert.rejects(
        () => exportGraph(graph, kuzuVersion()),
        (err: unknown) => {
          assert.ok(err instanceof GraphTransferError, `expected a GraphTransferError, got ${String(err)}`);
          assert.match(err.message, /MemoryNode poisoned properties is refused: the JSON key "__proto__" names a prototype/);
          assert.match(err.message, /Refusing to continue/);
          return true;
        },
      );
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export refuses a row whose stored properties are not JSON rather than writing {}', async () => {
  const dir = await tempDir('maf-transfer-badjson-');
  try {
    const graph = new MemoryGraph(path.join(dir, 'g.kuzu'));
    try {
      await graph.run({
        cypher: `CREATE (:MemoryNode {id: 'bad', kind: 'Task', label: 'bad', properties: 'not json',
                  run_id: 'r', created_at: '2026-09-30T12:00:00.000Z', updated_at: '2026-09-30T12:00:00.000Z'})`,
        params: {},
      });
      await assert.rejects(
        () => exportGraph(graph, kuzuVersion()),
        (err: unknown) => {
          assert.ok(err instanceof GraphTransferError, `expected a GraphTransferError, got ${String(err)}`);
          assert.match(err.message, /MemoryNode bad properties is not valid JSON/);
          assert.match(err.message, /Refusing to continue/);
          return true;
        },
      );
    } finally {
      graph.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('close() leaves one database file, no write-ahead log beside it, and the rows reopen', async () => {
  const dir = await tempDir('maf-transfer-close-');
  try {
    const file = path.join(dir, 'memory.kuzu');
    const graph = new MemoryGraph(file);
    await graph.addNode({ kind: 'Task', label: 'survives close', properties: {}, runId: makeRunId('close') });
    graph.close(); // does not throw, and the native handles are released now

    assert.ok((await stat(file)).isFile(), 'Kùzu 0.11.3 writes a single file, which is not the 0.7.x shape');
    assert.deepEqual(await readdir(dir), [path.basename(file)], 'a clean close folds the write-ahead log in');

    const reopened = new MemoryGraph(file);
    try {
      assert.deepEqual(await count(reopened), { nodes: 1, edges: 0 });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
