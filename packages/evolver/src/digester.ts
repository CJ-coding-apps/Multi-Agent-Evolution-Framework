import type { MemoryGraph } from '@maf/memory-graph';

/**
 * Digester (plan §6.2 step 1) — deterministic evidence assembly. No LLM in v1:
 * queries the memory graph for golden history, failures, and shipped edits.
 * The LLM reads the Digest; it does not produce it.
 */

export interface GoldenHistoryRow {
  harnessId: string;
  harnessSha: string;
  solved: string[];
  total: number;
  ranAt: string;
}

export interface FailureRow {
  label: string;
  properties: Record<string, unknown>;
  runId: string;
}

export interface Digest {
  goldenHistory: GoldenHistoryRow[];
  currentFailures: FailureRow[];
  policyEvents: FailureRow[];
  generatedAt: string;
}

function parseProps(row: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(String(row['n.properties'] ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function digestEvidence(graph: MemoryGraph, failureLimit = 20): Promise<Digest> {
  const goldenRows = await graph.query(
    "MATCH (n:MemoryNode) WHERE n.kind = 'GoldenResult' RETURN n.label, n.properties ORDER BY n.created_at DESC LIMIT 50",
    {},
  );
  const goldenHistory: GoldenHistoryRow[] = goldenRows.map((raw) => {
    const r = raw as Record<string, unknown>;
    const props = parseProps(r);
    return {
      harnessId: String(props['harnessId'] ?? ''),
      harnessSha: String(props['harness_sha'] ?? ''),
      solved: Array.isArray(props['solved']) ? (props['solved'] as string[]) : [],
      total: Number(props['total'] ?? 0),
      ranAt: String(props['ranAt'] ?? ''),
    };
  });

  const failureRows = await graph.query(
    "MATCH (n:MemoryNode) WHERE n.kind = 'Failure' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT $lim",
    { lim: failureLimit },
  );
  const currentFailures: FailureRow[] = failureRows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return { label: String(r['n.label'] ?? ''), properties: parseProps(r), runId: String(r['n.run_id'] ?? '') };
  });

  const policyRows = await graph.query(
    "MATCH (n:MemoryNode) WHERE n.kind = 'PolicyEvent' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT $lim",
    { lim: failureLimit },
  );
  const policyEvents: FailureRow[] = policyRows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return { label: String(r['n.label'] ?? ''), properties: parseProps(r), runId: String(r['n.run_id'] ?? '') };
  });

  return { goldenHistory, currentFailures, policyEvents, generatedAt: new Date().toISOString() };
}
