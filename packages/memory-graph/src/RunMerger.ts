import crypto from 'node:crypto';
import type { RunId, MergeReport, MemoryNodeKind, GraphRow } from '@maf/types';
import type { KuzuDriver } from './KuzuDriver.js';
import { intLiteral } from './cypherText.js';

function tryParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

export class RunMerger {
  constructor(private readonly driver: KuzuDriver) {}

  async merge(sourceRunIds: RunId[], targetRunId: RunId): Promise<MergeReport> {
    let nodesCreated = 0, edgesCreated = 0;
    const conflicts: string[] = [];

    for (const sourceRunId of sourceRunIds) {
      let sourceNodes: Array<{ kind: MemoryNodeKind; label: string; properties: Record<string, unknown> }> = [];
      try {
        const rows = await this.driver.run({
          cypher: `MATCH (n:MemoryNode {run_id: $runId}) RETURN n LIMIT ${intLiteral(1000, 'limit')}`,
          params: { runId: sourceRunId },
        });
        sourceNodes = rows.map(rowToNode);
      } catch { continue; }

      for (const node of sourceNodes) {
        try {
          const ex = await this.driver.run({
            cypher: `MATCH (n:MemoryNode {kind: $kind, label: $label, run_id: $runId}) RETURN n.id LIMIT 1`,
            params: { kind: node.kind, label: node.label, runId: targetRunId },
          });
          if (ex.length > 0) { conflicts.push(`${node.kind}:${node.label}`); continue; }
        } catch { /* no conflict */ }

        const id  = crypto.randomUUID();
        const now = new Date().toISOString();
        await this.driver.run({
          cypher: `CREATE (:MemoryNode {id: $id, kind: $kind, label: $label, properties: $properties, run_id: $runId, created_at: $now, updated_at: $now})`,
          params: {
            id, kind: node.kind, label: node.label,
            properties: JSON.stringify(node.properties), runId: targetRunId, now,
          },
        });
        nodesCreated++;
      }

      // Provenance node
      const mergeNodeId = crypto.randomUUID();
      const now = new Date().toISOString();
      await this.driver.run({
        cypher: `CREATE (:MemoryNode {id: $id, kind: 'Run', label: $label, properties: $properties, run_id: $runId, created_at: $now, updated_at: $now})`,
        params: {
          id: mergeNodeId, label: sourceRunId,
          properties: JSON.stringify({ mergedFrom: sourceRunId, mergedAt: now }),
          runId: targetRunId, now,
        },
      });
      nodesCreated++;

      try {
        const rows = await this.driver.run({
          cypher: `MATCH (n:MemoryNode {kind: 'Run', run_id: $runId}) RETURN n.id LIMIT 1`,
          params: { runId: targetRunId },
        });
        if (rows[0]) {
          const targetNodeId = String(rows[0]['n.id'] ?? '');
          const edgeId = crypto.randomUUID();
          await this.driver.run({
            cypher: `MATCH (a:MemoryNode {id: $fromId}), (b:MemoryNode {id: $toId})`
              + ` CREATE (a)-[:MemoryEdge {id: $id, relation: 'MERGED_FROM', weight: 1, metadata: '{}', created_at: $now}]->(b)`,
            params: { fromId: mergeNodeId, toId: targetNodeId, id: edgeId, now },
          });
          edgesCreated++;
        }
      } catch { /* skip edge */ }
    }

    return { nodesCreated, edgesCreated, conflictsFound: conflicts, mergedAt: new Date() };
  }
}

function rowToNode(r: GraphRow): { kind: MemoryNodeKind; label: string; properties: Record<string, unknown> } {
  const n = (r['n'] ?? r) as GraphRow;
  return {
    kind:       String(n['kind'] ?? '') as MemoryNodeKind,
    label:      String(n['label'] ?? ''),
    properties: tryParse(String(n['properties'] ?? '{}')),
  };
}
