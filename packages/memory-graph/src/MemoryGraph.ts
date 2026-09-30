import crypto from 'node:crypto';
import type {
  MemoryGraphApi, MemoryNode, MemoryEdge, MemorySubgraph,
  MemoryNodeKind, MemoryRelation, MergeReport, RunId,
  GraphQuery, GraphRow,
} from '@maf/types';
import { KuzuDriver } from './KuzuDriver.js';
import { SCHEMA_DDL } from './schema.js';
import { intLiteral, idListParams } from './cypherText.js';

export class MemoryGraph implements MemoryGraphApi {
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

    let rows: GraphRow[] = [];
    try {
      rows = await this.driver.run({
        cypher: `MATCH (n:MemoryNode) RETURN n LIMIT ${intLiteral(maxNodes * 3, 'maxNodes')}`,
        params: {},
      });
    } catch { return empty(taskContext); }

    const scored = rows
      .map(rowToNode)
      .map((n) => [n, score(n, keywords)] as [MemoryNode, number])
      .filter(([, s]) => s > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, maxNodes);

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

function score(node: MemoryNode, keywords: string[]): number {
  const text = `${node.label} ${node.kind} ${JSON.stringify(node.properties)}`.toLowerCase();
  return keywords.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0);
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
