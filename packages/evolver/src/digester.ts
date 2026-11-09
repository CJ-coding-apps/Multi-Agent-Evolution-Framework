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
  /** D-57: which split the row measured; absent for a full-corpus run or an older row. */
  split?: string;
}

export interface FailureRow {
  label: string;
  properties: Record<string, unknown>;
  runId: string;
}

/**
 * A round this — or an earlier — evolution run recorded (WP-3.7 §7). The loop writes one
 * `EvolutionRound` per round; the digester reads them back so the planner is told what it already
 * proposed and how that turned out, instead of proposing the same rejected edit every round.
 */
export interface EvolutionRoundRow {
  round: number;
  outcome: string;
  /** The round note as recorded, masked on the way out like every other piece of evidence. */
  note: string;
  harnessSha: string;
}

export interface Digest {
  goldenHistory: GoldenHistoryRow[];
  currentFailures: FailureRow[];
  policyEvents: FailureRow[];
  evolutionRounds: EvolutionRoundRow[];
  /**
   * WP-3.7 §7: a graph query that failed, named. A digest is evidence, and missing evidence is a
   * thinner digest — not a reason to abort an evolution run, whose next action is a model call the
   * operator has already paid for. The loop copies these into the report so the degradation is
   * visible rather than silent.
   */
  errors: string[];
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

/**
 * Run one digest query. A failing read is evidence the digest lacks, not a fatal error (§7): the
 * planner can still propose from the reads that succeeded, and the loop reports the gap.
 */
async function readRows(
  graph: MemoryGraph, what: string, cypher: string, errors: string[],
): Promise<ReadonlyArray<Record<string, unknown>>> {
  try {
    return await graph.run({ cypher, params: {} });
  } catch (err) {
    errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function digestEvidence(graph: MemoryGraph, failureLimit = 20): Promise<Digest> {
  // `LIMIT` is one of the two positions Cypher cannot bind, so the limit is a validated literal.
  const limit = intLiteral(failureLimit, 'failureLimit');
  const errors: string[] = [];

  const goldenRows = await readRows(
    graph, 'golden history',
    'MATCH (n:MemoryNode) WHERE n.kind = \'GoldenResult\' RETURN n.label, n.properties ORDER BY n.created_at DESC LIMIT 50',
    errors,
  );
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
      ...(typeof props['split'] === 'string' ? { split: props['split'] } : {}),
    };
  });

  const failureRows = await readRows(
    graph, 'failures',
    `MATCH (n:MemoryNode) WHERE n.kind = 'Failure' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT ${limit}`,
    errors,
  );
  const currentFailures: FailureRow[] = failureRows.map((raw) => ({
    label: String(raw['n.label'] ?? ''), properties: parseProps(raw), runId: String(raw['n.run_id'] ?? ''),
  }));

  // WP-3.7a MED-2, R2-L2: the graph may still hold `Allow` events written before the engine stopped
  // recording them. The filter is in the query — on the label, which is a column — so no number of
  // newer Allows can starve an older refusal out of the window. The events are newest-first and the
  // query itself caps the result at `failureLimit`. A client-side filter stays as a backstop for a
  // row whose label was written by something other than this engine's `recordEvent`.
  const policyRows = await readRows(
    graph, 'policy events',
    `MATCH (n:MemoryNode) WHERE n.kind = 'PolicyEvent' AND NOT n.label STARTS WITH 'policy Allow' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT ${limit}`,
    errors,
  );
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

  // §7: the rounds the loop writes are read back. Without this the planner sees a rejected edit's
  // golden row but not the refusal that explains it, and proposes the same edit again. The note is
  // free text that quotes refusals and tool ids, so it is masked exactly as policy events are.
  const roundRows = await readRows(
    graph, 'evolution rounds',
    `MATCH (n:MemoryNode) WHERE n.kind = 'EvolutionRound' RETURN n.label, n.properties ORDER BY n.created_at DESC LIMIT ${limit}`,
    errors,
  );
  const evolutionRounds: EvolutionRoundRow[] = roundRows.map((raw) => {
    const props = parseProps(raw);
    return {
      round: Number(props['round'] ?? 0),
      outcome: String(props['outcome'] ?? ''),
      note: masked(String(props['note'] ?? '')),
      harnessSha: String(props['harness_sha'] ?? ''),
    };
  });

  return {
    goldenHistory, currentFailures, policyEvents, evolutionRounds, errors,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Whether the digest carries nothing a proposal could be based on. `no_op` is the right answer to
 * this state — the loop says so in the round note instead of leaving it silent.
 */
export function isEmptyDigest(digest: Digest): boolean {
  return digest.goldenHistory.length === 0
    && digest.currentFailures.length === 0
    && digest.policyEvents.length === 0
    && digest.evolutionRounds.length === 0;
}
