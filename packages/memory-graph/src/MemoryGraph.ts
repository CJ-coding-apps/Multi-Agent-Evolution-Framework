import crypto from 'node:crypto';
import type {
  MemoryGraphApi, MemoryNode, MemoryEdge, MemorySubgraph,
  MemoryNodeKind, MemoryRelation, MergeReport, RunId,
} from '@maf/types';
import { KuzuDriver } from './KuzuDriver.js';
import { SCHEMA_DDL } from './schema.js';

export class MemoryGraph implements MemoryGraphApi {
  private driver: KuzuDriver;
  private schemaReady: Promise<void>;

  constructor(dbPath: string, bufferPoolSizeBytes = 128 * 1024 * 1024) {
    this.driver = new KuzuDriver(dbPath, bufferPoolSizeBytes);
    this.schemaReady = this.initSchema();
  }

  private async initSchema(): Promise<void> {
    for (const stmt of SCHEMA_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
      try { await this.driver.execute(stmt); } catch { /* ignore already-exists */ }
    }
  }

  async addNode(n: Omit<MemoryNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    await this.schemaReady;
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.execute(
      `CREATE (:MemoryNode {id: '${esc(id)}', kind: '${esc(n.kind)}', label: '${esc(n.label)}', properties: '${esc(JSON.stringify(n.properties))}', run_id: '${esc(n.runId)}', created_at: '${now}', updated_at: '${now}'})`,
    );
    return id;
  }

  async addEdge(e: Omit<MemoryEdge, 'id' | 'createdAt'>): Promise<string> {
    await this.schemaReady;
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.execute(
      `MATCH (a:MemoryNode {id: '${esc(e.fromId)}'}), (b:MemoryNode {id: '${esc(e.toId)}'})
       CREATE (a)-[:MemoryEdge {id: '${esc(id)}', relation: '${esc(e.relation)}', weight: ${e.weight}, metadata: '${esc(JSON.stringify(e.metadata))}', created_at: '${now}'}]->(b)`,
    );
    return id;
  }

  async query(cypher: string, params: Record<string, unknown>): Promise<unknown[]> {
    await this.schemaReady;
    let resolved = cypher;
    for (const [k, v] of Object.entries(params)) {
      resolved = resolved.replace(new RegExp(`\\$${k}`, 'g'), typeof v === 'string' ? `'${esc(v)}'` : String(v));
    }
    try {
      const result = await this.driver.query(resolved);
      return await result.getAll();
    } catch { return []; }
  }

  async querySubgraph(taskContext: string, maxNodes: number): Promise<MemorySubgraph> {
    await this.schemaReady;
    const keywords = taskContext.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    if (keywords.length === 0) return empty(taskContext);

    let rows: Array<Record<string, unknown>> = [];
    try {
      const result = await this.driver.query(`MATCH (n:MemoryNode) RETURN n LIMIT ${maxNodes * 3}`);
      rows = await result.getAll() as Array<Record<string, unknown>>;
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
    const nodeIds = nodes.map((n) => `'${esc(n.id)}'`).join(',');

    let edges: MemoryEdge[] = [];
    try {
      const edgeResult = await this.driver.query(
        `MATCH (a:MemoryNode)-[e:MemoryEdge]->(b:MemoryNode)
         WHERE a.id IN [${nodeIds}] OR b.id IN [${nodeIds}]
         RETURN e.id AS eid, e.relation AS rel, e.weight AS w, e.metadata AS meta, e.created_at AS cat, a.id AS from_id, b.id AS to_id
         LIMIT ${maxNodes * 2}`,
      );
      edges = (await edgeResult.getAll() as Array<Record<string, unknown>>).map(rowToEdge);
    } catch { /* edges best-effort */ }

    return { nodes, edges, queryContext: taskContext, relevanceScores };
  }

  async mergeRuns(sourceRunIds: RunId[], targetRunId: RunId): Promise<MergeReport> {
    await this.schemaReady;
    let nodesCreated = 0, edgesCreated = 0;
    const conflicts: string[] = [];

    for (const sourceRunId of sourceRunIds) {
      let sourceRows: Array<Record<string, unknown>> = [];
      try {
        const r = await this.driver.query(`MATCH (n:MemoryNode {run_id: '${esc(sourceRunId)}'}) RETURN n LIMIT 1000`);
        sourceRows = await r.getAll() as Array<Record<string, unknown>>;
      } catch { continue; }

      for (const node of sourceRows.map(rowToNode)) {
        try {
          const ex = await this.driver.query(
            `MATCH (n:MemoryNode {label: '${esc(node.label)}', kind: '${esc(node.kind)}', run_id: '${esc(targetRunId)}'}) RETURN n.id LIMIT 1`,
          );
          if ((await ex.getAll()).length > 0) { conflicts.push(`${node.kind}:${node.label}`); continue; }
        } catch { /* treat as no conflict */ }
        await this.addNode({ kind: node.kind, label: node.label, properties: node.properties, runId: targetRunId });
        nodesCreated++;
      }

      const mergedId = await this.addNode({ kind: 'Run' as MemoryNodeKind, label: sourceRunId, properties: { mergedFrom: sourceRunId }, runId: targetRunId });
      nodesCreated++;

      try {
        const tr = await this.driver.query(`MATCH (n:MemoryNode {kind: 'Run', run_id: '${esc(targetRunId)}'}) RETURN n.id LIMIT 1`);
        const targetRows = await tr.getAll() as Array<Record<string, unknown>>;
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

function esc(s: string): string { return s.replace(/'/g, "''"); }

function score(node: MemoryNode, keywords: string[]): number {
  const text = `${node.label} ${node.kind} ${JSON.stringify(node.properties)}`.toLowerCase();
  return keywords.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0);
}

function empty(ctx: string): MemorySubgraph {
  return { nodes: [], edges: [], queryContext: ctx, relevanceScores: new Map() };
}

function rowToNode(r: Record<string, unknown>): MemoryNode {
  const n = (r['n'] ?? r) as Record<string, unknown>;
  return {
    id:         String(n['id'] ?? ''),
    kind:       String(n['kind'] ?? '') as MemoryNodeKind,
    label:      String(n['label'] ?? ''),
    properties: tryParse(String(n['properties'] ?? '{}')),
    runId:      String(n['run_id'] ?? '') as RunId,
    createdAt:  new Date(String(n['created_at'] ?? new Date())),
    updatedAt:  new Date(String(n['updated_at'] ?? new Date())),
  };
}

function rowToEdge(r: Record<string, unknown>): MemoryEdge {
  return {
    id:        String(r['eid'] ?? ''),
    fromId:    String(r['from_id'] ?? ''),
    toId:      String(r['to_id'] ?? ''),
    relation:  String(r['rel'] ?? '') as MemoryRelation,
    weight:    Number(r['w'] ?? 1),
    metadata:  tryParse(String(r['meta'] ?? '{}')),
    createdAt: new Date(String(r['cat'] ?? new Date())),
  };
}

function tryParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
