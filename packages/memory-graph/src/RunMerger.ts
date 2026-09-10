import crypto from 'node:crypto';
import type { RunId, MergeReport, MemoryNodeKind } from '@maf/types';
import type { KuzuDriver } from './KuzuDriver.js';

function esc(s: string): string { return s.replace(/'/g, "''"); }
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
        const r = await this.driver.query(
          `MATCH (n:MemoryNode {run_id: '${esc(sourceRunId)}'}) RETURN n LIMIT 1000`
        );
        sourceNodes = (await r.getAll() as Array<Record<string, unknown>>).map(rowToNode);
      } catch { continue; }

      for (const node of sourceNodes) {
        try {
          const ex = await this.driver.query(
            `MATCH (n:MemoryNode {kind: '${esc(node.kind)}', label: '${esc(node.label)}', run_id: '${esc(targetRunId)}'}) RETURN n.id LIMIT 1`
          );
          if ((await ex.getAll()).length > 0) { conflicts.push(`${node.kind}:${node.label}`); continue; }
        } catch { /* no conflict */ }

        const id  = crypto.randomUUID();
        const now = new Date().toISOString();
        await this.driver.execute(
          `CREATE (:MemoryNode {id: '${esc(id)}', kind: '${esc(node.kind)}', label: '${esc(node.label)}', properties: '${esc(JSON.stringify(node.properties))}', run_id: '${esc(targetRunId)}', created_at: '${now}', updated_at: '${now}'})`
        );
        nodesCreated++;
      }

      // Provenance node
      const mergeNodeId = crypto.randomUUID();
      const now = new Date().toISOString();
      await this.driver.execute(
        `CREATE (:MemoryNode {id: '${esc(mergeNodeId)}', kind: 'Run', label: '${esc(sourceRunId)}', properties: '${esc(JSON.stringify({ mergedFrom: sourceRunId, mergedAt: now }))}', run_id: '${esc(targetRunId)}', created_at: '${now}', updated_at: '${now}'})`
      );
      nodesCreated++;

      try {
        const tr = await this.driver.query(
          `MATCH (n:MemoryNode {kind: 'Run', run_id: '${esc(targetRunId)}'}) RETURN n.id LIMIT 1`
        );
        const rows = await tr.getAll() as Array<Record<string, unknown>>;
        if (rows[0]) {
          const targetNodeId = String(rows[0]['n.id'] ?? '');
          const edgeId = crypto.randomUUID();
          await this.driver.execute(
            `MATCH (a:MemoryNode {id: '${esc(mergeNodeId)}'}), (b:MemoryNode {id: '${esc(targetNodeId)}'})`
            + ` CREATE (a)-[:MemoryEdge {id: '${esc(edgeId)}', relation: 'MERGED_FROM', weight: 1, metadata: '{}', created_at: '${now}'}]->(b)`
          );
          edgesCreated++;
        }
      } catch { /* skip edge */ }
    }

    return { nodesCreated, edgesCreated, conflictsFound: conflicts, mergedAt: new Date() };
  }
}

function rowToNode(r: Record<string, unknown>): { kind: MemoryNodeKind; label: string; properties: Record<string, unknown> } {
  const n = (r['n'] ?? r) as Record<string, unknown>;
  return {
    kind:       String(n['kind'] ?? '') as MemoryNodeKind,
    label:      String(n['label'] ?? ''),
    properties: tryParse(String(n['properties'] ?? '{}')),
  };
}
