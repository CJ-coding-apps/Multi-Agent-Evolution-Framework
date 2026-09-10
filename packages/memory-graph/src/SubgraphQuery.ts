import type { MemoryNode, MemoryEdge, MemorySubgraph, MemoryNodeKind } from '@maf/types';
import type { KuzuDriver } from './KuzuDriver.js';

function esc(s: string): string { return s.replace(/'/g, "''"); }
function tryParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

export class SubgraphQuery {
  constructor(private readonly driver: KuzuDriver) {}

  async query(taskContext: string, maxNodes: number): Promise<MemorySubgraph> {
    const keywords = taskContext.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    if (keywords.length === 0) return empty(taskContext);

    let allNodes: MemoryNode[] = [];
    try {
      const result = await this.driver.query(`MATCH (n:MemoryNode) RETURN n LIMIT ${maxNodes * 3}`);
      allNodes = (await result.getAll() as Array<Record<string, unknown>>).map(rowToNode);
    } catch { return empty(taskContext); }

    const scored: Array<[MemoryNode, number]> = allNodes
      .map((n) => [n, scoreNode(n, keywords)] as [MemoryNode, number])
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
         WHERE a.id IN [${nodeIds}] AND b.id IN [${nodeIds}]
         RETURN e.id AS eid, e.relation AS rel, e.weight AS w, e.metadata AS meta, e.created_at AS cat, a.id AS from_id, b.id AS to_id
         LIMIT ${maxNodes * 2}`,
      );
      edges = (await edgeResult.getAll() as Array<Record<string, unknown>>).map(rowToEdge);
    } catch { /* edges are best-effort */ }

    return { nodes, edges, queryContext: taskContext, relevanceScores };
  }

  async expand(seedIds: string[], hops: number, maxNodes: number): Promise<MemorySubgraph> {
    if (seedIds.length === 0) return empty('');
    const ids = seedIds.map((id) => `'${esc(id)}'`).join(',');
    try {
      const result = await this.driver.query(
        `MATCH (seed:MemoryNode)-[*1..${hops}]-(n:MemoryNode)
         WHERE seed.id IN [${ids}]
         RETURN DISTINCT n LIMIT ${maxNodes}`,
      );
      const nodes = (await result.getAll() as Array<Record<string, unknown>>).map(rowToNode);
      const relevanceScores = new Map(nodes.map((n, i) => [n.id, 1 - i / nodes.length]));
      return { nodes, edges: [], queryContext: '', relevanceScores };
    } catch { return empty(''); }
  }
}

function scoreNode(node: MemoryNode, keywords: string[]): number {
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
    runId:      String(n['run_id'] ?? '') as import('@maf/types').RunId,
    createdAt:  new Date(String(n['created_at'] ?? new Date())),
    updatedAt:  new Date(String(n['updated_at'] ?? new Date())),
  };
}

function rowToEdge(r: Record<string, unknown>): MemoryEdge {
  return {
    id:        String(r['eid'] ?? ''),
    fromId:    String(r['from_id'] ?? ''),
    toId:      String(r['to_id'] ?? ''),
    relation:  String(r['rel'] ?? '') as import('@maf/types').MemoryRelation,
    weight:    Number(r['w'] ?? 1),
    metadata:  tryParse(String(r['meta'] ?? '{}')),
    createdAt: new Date(String(r['cat'] ?? new Date())),
  };
}
