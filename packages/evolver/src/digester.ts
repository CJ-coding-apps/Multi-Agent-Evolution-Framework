import type { MemoryGraph } from '@maf/memory-graph';
import { intLiteral } from '@maf/memory-graph';
import { redactEvidenceText, refusePrototypeKey } from '@maf/types';

/**
 * Digester (plan §6.2 step 1) — deterministic evidence assembly. No LLM in v1:
 * queries the memory graph for golden history, failures, and shipped edits.
 * The LLM reads the Digest; it does not produce it.
 */

export interface GoldenHistoryRow {
  harnessId: string;
  harnessSha: string;
  solved: string[];
  /** Tasks the run failed, from the recorder's per-task rows; empty for an older row without them. */
  failed: string[];
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
    // WP-3.9 G5: a graph row's properties column comes out of `.maf/`, so it is read through the
    // shared reviver. A refused blob is treated exactly like an unparseable one — empty — so a
    // poisoned row cannot contribute evidence to the planner.
    return JSON.parse(String(row['n.properties'] ?? '{}'), refusePrototypeKey) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function digestEvidence(graph: MemoryGraph, failureLimit = 20): Promise<Digest> {
  // `LIMIT` is one of the two positions Cypher cannot bind, so the limit is a validated literal.
  const limit = intLiteral(failureLimit, 'failureLimit');

  const goldenRows = await graph.run({
    cypher: "MATCH (n:MemoryNode) WHERE n.kind = 'GoldenResult' RETURN n.label, n.properties ORDER BY n.created_at DESC LIMIT 50",
    params: {},
  });
  const goldenHistory: GoldenHistoryRow[] = goldenRows.map((raw) => {
    const props = parseProps(raw);
    // `ScoreRecorder` writes every task's verdict beside the score. The ids of the ones that did
    // not pass are what a proposal can target, so the digest carries them rather than leaving the
    // planner to subtract two counts.
    const perTask = Array.isArray(props['perTask']) ? (props['perTask'] as unknown[]) : [];
    const failed = perTask
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .filter((t) => t['passed'] === false)
      .map((t) => String(t['taskId'] ?? ''));
    return {
      harnessId: String(props['harnessId'] ?? ''),
      harnessSha: String(props['harness_sha'] ?? ''),
      solved: Array.isArray(props['solved']) ? (props['solved'] as string[]) : [],
      failed,
      total: Number(props['total'] ?? 0),
      ranAt: String(props['ranAt'] ?? ''),
    };
  });

  const failureRows = await graph.run({
    cypher: `MATCH (n:MemoryNode) WHERE n.kind = 'Failure' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT ${limit}`,
    params: {},
  });
  const currentFailures: FailureRow[] = failureRows.map((raw) => ({
    label: String(raw['n.label'] ?? ''), properties: parseProps(raw), runId: String(raw['n.run_id'] ?? ''),
  }));

  // WP-3.7a MED-2, R2-L2: the graph may still hold `Allow` events written before the engine stopped
  // recording them. The filter is in the query — on the label, which is a column — so no number of
  // newer Allows can starve an older refusal out of the window. The events are newest-first and the
  // query itself caps the result at `failureLimit`. A client-side filter stays as a backstop for a
  // row whose label was written by something other than this engine's `recordEvent`.
  const policyRows = await graph.run({
    cypher: `MATCH (n:MemoryNode) WHERE n.kind = 'PolicyEvent' AND NOT n.label STARTS WITH 'policy Allow' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT ${limit}`,
    params: {},
  });
  // WP-3.7a MED-1, second layer: a row written by an older version may hold an unmasked reason,
  // and this text reaches the planner's prompt. Mask on the way out as well as on the way in.
  const masked = (text: string): string => redactEvidenceText(text);
  const maskProps = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).map(
      ([key, value]) => [key, typeof value === 'string' ? masked(value) : value],
    ));
  const policyEvents: FailureRow[] = policyRows
    .map((raw) => ({
      label: masked(String(raw['n.label'] ?? '')),
      properties: maskProps(parseProps(raw)),
      runId: String(raw['n.run_id'] ?? ''),
    }))
    .filter((e) => e.properties['verdict'] !== 'Allow' && !e.label.startsWith('policy Allow '))
    .slice(0, failureLimit);

  return { goldenHistory, currentFailures, policyEvents, generatedAt: new Date().toISOString() };
}

/**
 * Whether the digest carries nothing a proposal could be based on. `no_op` is the right answer to
 * this state — the loop says so in the round note instead of leaving it silent.
 */
export function isEmptyDigest(digest: Digest): boolean {
  return digest.goldenHistory.length === 0
    && digest.currentFailures.length === 0
    && digest.policyEvents.length === 0;
}
