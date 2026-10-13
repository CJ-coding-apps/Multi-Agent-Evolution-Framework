import crypto from 'node:crypto';
import type {
  MemoryGraphApi, MemoryNode, MemoryEdge, MemorySubgraph,
  MemoryNodeKind, MemoryRelation, MergeReport, RunId,
  GraphQuery, GraphRow, GraphQueryRunner, FailureRecorder, NodeFailureRecord,
} from '@maf/types';
import { KuzuDriver } from './KuzuDriver.js';
import { SCHEMA_DDL } from './schema.js';
import { intLiteral, idListParams } from './cypherText.js';

export class MemoryGraph implements MemoryGraphApi, FailureRecorder {
  private driver: KuzuDriver;
  private schemaReady: Promise<void>;

  constructor(dbPath: string, bufferPoolSizeBytes = 128 * 1024 * 1024) {
    this.driver = new KuzuDriver(dbPath, bufferPoolSizeBytes);
    this.schemaReady = this.initSchema();
  }

  private async initSchema(): Promise<void> {
    for (const stmt of SCHEMA_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
      try { await this.driver.run({ cypher: stmt, params: {} }); } catch { /* ignore already-exists */ }
    }
  }

  /** The one way a value reaches a query: named in `params`, never written into `cypher`. */
  async run(query: GraphQuery): Promise<GraphRow[]> {
    await this.schemaReady;
    return this.driver.run(query);
  }

  async addNode(n: Omit<MemoryNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    await this.schemaReady;
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.run({
      cypher: `CREATE (:MemoryNode {id: $id, kind: $kind, label: $label, properties: $properties, run_id: $runId, created_at: $now, updated_at: $now})`,
      params: {
        id, kind: n.kind, label: n.label,
        properties: JSON.stringify(n.properties), runId: n.runId, now,
      },
    });
    return id;
  }

  async addEdge(e: Omit<MemoryEdge, 'id' | 'createdAt'>): Promise<string> {
    await this.schemaReady;
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.run({
      cypher: `MATCH (a:MemoryNode {id: $fromId}), (b:MemoryNode {id: $toId})
       CREATE (a)-[:MemoryEdge {id: $id, relation: $relation, weight: $weight, metadata: $metadata, created_at: $now}]->(b)`,
      params: {
        fromId: e.fromId, toId: e.toId, id, relation: e.relation,
        weight: e.weight, metadata: JSON.stringify(e.metadata), now,
      },
    });
    return id;
  }

  async querySubgraph(taskContext: string, maxNodes: number): Promise<MemorySubgraph> {
    await this.schemaReady;
    const keywords = taskContext.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    if (keywords.length === 0) return empty(taskContext);

    // Scored and ranked in the query, then limited. This took the first `maxNodes * 3` nodes in
    // storage order and filtered those, so past that size the newest memory was never searched.
    // A keyword holds no whitespace, so testing each column is the same as testing the old
    // `label kind properties` text.
    const params: Record<string, string> = {};
    const hits = keywords.map((word, i) => {
      const p = `$kw${i}`;
      params[`kw${i}`] = word;
      return `(CASE WHEN lower(n.label) CONTAINS ${p} OR lower(n.kind) CONTAINS ${p} OR lower(n.properties) CONTAINS ${p} THEN 1 ELSE 0 END)`;
    }).join(' + ');
    let rows: GraphRow[] = [];
    try {
      rows = await this.driver.run({
        cypher: `MATCH (n:MemoryNode) WITH n, ${hits} AS score WHERE score > 0
         RETURN n, score ORDER BY score DESC, n.created_at DESC LIMIT ${intLiteral(maxNodes, 'maxNodes')}`,
        params,
      });
    } catch { return empty(taskContext); }

    const scored = rows.map((r) => [rowToNode(r), Number(r['score'])] as [MemoryNode, number]);

    if (scored.length === 0) return empty(taskContext);

    const nodes = scored.map(([n]) => n);
    const relevanceScores = new Map(scored.map(([n, s]) => [n.id, s]));
    const ids = idListParams('nid', nodes.map((n) => n.id));

    let edges: MemoryEdge[] = [];
    try {
      const edgeRows = await this.driver.run({
        cypher: `MATCH (a:MemoryNode)-[e:MemoryEdge]->(b:MemoryNode)
         WHERE a.id IN [${ids.placeholders}] OR b.id IN [${ids.placeholders}]
         RETURN e.id AS eid, e.relation AS rel, e.weight AS w, e.metadata AS meta, e.created_at AS cat, a.id AS from_id, b.id AS to_id
         LIMIT ${intLiteral(maxNodes * 2, 'maxNodes')}`,
        params: ids.params,
      });
      edges = edgeRows.map(rowToEdge);
    } catch { /* edges best-effort */ }

    return { nodes, edges, queryContext: taskContext, relevanceScores };
  }

  /**
   * D-16: a failed node, written in the shape `recallFailures` reads — a `Task` that
   * `CAUSED_FAILURE` a `Failure`, the relation a value on `MemoryEdge`. One statement, so a crash
   * between writes cannot leave a Task with no Failure, or a Failure no recall can reach.
   */
  async recordFailure(input: NodeFailureRecord): Promise<void> {
    await this.schemaReady;
    const now = new Date().toISOString();
    await this.driver.run({
      cypher: `CREATE (:MemoryNode {id: $taskId, kind: 'Task', label: $task, properties: $taskProps, run_id: $runId, created_at: $now, updated_at: $now})
         -[:MemoryEdge {id: $edgeId, relation: 'CAUSED_FAILURE', weight: 1.0, metadata: '{}', created_at: $now}]->
         (:MemoryNode {id: $failureId, kind: 'Failure', label: $nodeId, properties: $failureProps, run_id: $runId, created_at: $now, updated_at: $now})`,
      params: {
        taskId: crypto.randomUUID(), edgeId: crypto.randomUUID(), failureId: crypto.randomUUID(),
        task: input.task, nodeId: input.nodeId, runId: input.runId, now,
        taskProps: JSON.stringify({
          nodeId: input.nodeId, nodeLabel: input.label, role: input.role,
          ...(input.runTitle === undefined ? {} : { runTitle: input.runTitle }),
        }),
        failureProps: JSON.stringify({
          nodeId: input.nodeId, role: input.role, reason: input.reason, message: input.message,
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        }),
      },
    });
  }

  recallFailures(filter: FailureRecallFilter): Promise<RecalledFailure[]> {
    return recallFailures(this, filter);
  }

  async mergeRuns(sourceRunIds: RunId[], targetRunId: RunId): Promise<MergeReport> {
    await this.schemaReady;
    let nodesCreated = 0, edgesCreated = 0;
    const conflicts: string[] = [];

    for (const sourceRunId of sourceRunIds) {
      let sourceRows: GraphRow[] = [];
      try {
        sourceRows = await this.driver.run({
          cypher: `MATCH (n:MemoryNode {run_id: $runId}) RETURN n LIMIT ${intLiteral(1000, 'limit')}`,
          params: { runId: sourceRunId },
        });
      } catch { continue; }

      for (const node of sourceRows.map(rowToNode)) {
        try {
          const ex = await this.driver.run({
            cypher: `MATCH (n:MemoryNode {label: $label, kind: $kind, run_id: $runId}) RETURN n.id LIMIT 1`,
            params: { label: node.label, kind: node.kind, runId: targetRunId },
          });
          if (ex.length > 0) { conflicts.push(`${node.kind}:${node.label}`); continue; }
        } catch { /* treat as no conflict */ }
        await this.addNode({ kind: node.kind, label: node.label, properties: node.properties, runId: targetRunId });
        nodesCreated++;
      }

      const mergedId = await this.addNode({ kind: 'Run' as MemoryNodeKind, label: sourceRunId, properties: { mergedFrom: sourceRunId }, runId: targetRunId });
      nodesCreated++;

      try {
        const targetRows = await this.driver.run({
          cypher: `MATCH (n:MemoryNode {kind: 'Run', run_id: $runId}) RETURN n.id LIMIT 1`,
          params: { runId: targetRunId },
        });
        if (targetRows[0]) {
          await this.addEdge({ fromId: mergedId, toId: String(targetRows[0]['n.id'] ?? ''), relation: 'MERGED_FROM' as MemoryRelation, weight: 1, metadata: {} });
          edgesCreated++;
        }
      } catch { /* skip edge */ }
    }

    return { nodesCreated, edgesCreated, conflictsFound: conflicts, mergedAt: new Date() };
  }

  close(): void { this.driver.close(); }
}

/** What `recallFailures` matches. Every filter given must hold; with none, the latest failures. */
export interface FailureRecallFilter {
  /**
   * A task title. Its first three words, as one phrase, must appear in the failed task's text or
   * in the title of the run it was planned for, ignoring case: the planner's notion of "a similar
   * task".
   */
  title?: string;
  /** A file the failed task `MODIFIED` (the label of a `File` node). */
  path?:  string;
  limit:  number;
}

/** One failed node, as the planner reads it back. */
export interface RecalledFailure {
  task:       string;
  role:       string;
  reason:     string;
  message:    string;
  nodeId:     string;
  runId:      RunId;
  recordedAt: string;
}

/**
 * The failure recall (D-16): Tasks joined to the Failure each caused, most recent first. This is
 * the one copy of the query — the planner and `FailurePatternDetector` both call it — and it takes
 * the narrow `GraphQueryRunner`, because its callers read the graph and never write it.
 *
 * The query text is assembled from fixed fragments only; every value is a bound parameter.
 */
export async function recallFailures(
  graph: GraphQueryRunner,
  filter: FailureRecallFilter,
): Promise<RecalledFailure[]> {
  const params: Record<string, string> = {};
  let modified = '';
  let where = '';
  if (filter.path !== undefined) {
    params['path'] = filter.path;
    modified = `MATCH (t)-[:MemoryEdge {relation: 'MODIFIED'}]->(:MemoryNode {kind: 'File', label: $path})`;
  }
  if (filter.title !== undefined) {
    const phrase = filter.title.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    // A blank title is contained in every task, which is no recall at all.
    if (phrase === '') return [];
    params['phrase'] = phrase;
    // A planned node's label is its own step; the run's title is in its properties, which are
    // JSON text, so there the phrase is looked for as JSON writes it (a `"` or `\` escaped).
    params['phraseInJson'] = JSON.stringify(phrase).slice(1, -1);
    where = 'WHERE lower(t.label) CONTAINS $phrase OR lower(t.properties) CONTAINS $phraseInJson';
  }

  const rows = await graph.run({
    cypher: `MATCH (t:MemoryNode {kind: 'Task'})-[:MemoryEdge {relation: 'CAUSED_FAILURE'}]->(f:MemoryNode {kind: 'Failure'})
       ${modified}
       ${where}
       RETURN DISTINCT f.id AS id, t.label AS task, f.properties AS failure, f.run_id AS runId, f.created_at AS recordedAt
       ORDER BY recordedAt DESC, id LIMIT ${intLiteral(filter.limit, 'limit')}`,
    params,
  });

  return rows.map((r) => {
    const failure = tryParse(String(r['failure'] ?? '{}'), 'Failure.properties');
    const text = (key: string, fallback: string): string => {
      const value = failure[key];
      return typeof value === 'string' ? value : fallback;
    };
    return {
      task:       String(r['task'] ?? ''),
      role:       text('role', 'unknown'),
      reason:     text('reason', 'unknown'),
      message:    text('message', ''),
      nodeId:     text('nodeId', ''),
      runId:      String(r['runId'] ?? '') as RunId,
      recordedAt: String(r['recordedAt'] ?? ''),
    };
  });
}

function empty(ctx: string): MemorySubgraph {
  return { nodes: [], edges: [], queryContext: ctx, relevanceScores: new Map() };
}

function rowToNode(r: GraphRow): MemoryNode {
  const n = (r['n'] ?? r) as GraphRow;
  return {
    id:         String(n['id'] ?? ''),
    kind:       String(n['kind'] ?? '') as MemoryNodeKind,
    label:      String(n['label'] ?? ''),
    properties: tryParse(String(n['properties'] ?? '{}'), 'MemoryNode.properties'),
    runId:      String(n['run_id'] ?? '') as RunId,
    createdAt:  new Date(String(n['created_at'] ?? new Date())),
    updatedAt:  new Date(String(n['updated_at'] ?? new Date())),
  };
}

function rowToEdge(r: GraphRow): MemoryEdge {
  return {
    id:        String(r['eid'] ?? ''),
    fromId:    String(r['from_id'] ?? ''),
    toId:      String(r['to_id'] ?? ''),
    relation:  String(r['rel'] ?? '') as MemoryRelation,
    weight:    Number(r['w'] ?? 1),
    metadata:  tryParse(String(r['meta'] ?? '{}'), 'MemoryEdge.metadata'),
    createdAt: new Date(String(r['cat'] ?? new Date())),
  };
}

/**
 * Tolerant on the way out, but not silent. A stored properties blob that will not parse is
 * almost always a writer bug, and returning `{}` without a word made it indistinguishable from
 * an edge that genuinely carried no metadata — the same "nothing" for two different facts this
 * package keeps running into.
 */
function tryParse(s: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    console.warn(`[maf] memory-graph: ${what} is not valid JSON, reading it as empty: ${s.slice(0, 120)}`);
    return {};
  }
}
