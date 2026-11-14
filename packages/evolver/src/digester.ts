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

/**
 * WP-3.7b R2-H2: the line between what the evolver may learn from and what it is being judged on.
 *
 * A held-out task is a yardstick. If any trace of one reaches the planner — its score, a policy
 * refusal that names it, a note that quotes it — the planner can propose an edit aimed at it and
 * the held-out gate stops measuring generalisation. The loop therefore digests NOTHING that is not
 * provably train: rows must say `train` and carry this corpus's split sha, task ids in a row must
 * be train ids, and free text is scrubbed of every corpus id that is not.
 */
export interface EvidenceScope {
  /** Ids in the committed train split. */
  trainTaskIds: ReadonlySet<string>;
  /** The split definition's sha; a row stamped with another one measured another corpus. */
  splitsSha?: string;
  /**
   * Every corpus id, train and held out. Free text — a note, a refusal reason, a summary — naming
   * an id outside `trainTaskIds` is replaced before it can reach the digest.
   */
  corpusTaskIds?: ReadonlySet<string>;
}

const HELD_OUT_MENTION = '[held-out task]';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ids the evolver may not see, as one alternation. Longest id first, so an id that is a prefix
 * of another (`coder-fib` and `coder-fibonacci`) is not half-replaced. Whole-token boundaries keep
 * a short id from matching inside a longer word. `global` for replacing; a caller that only wants
 * to ask a yes/no question builds a non-global copy so a stateful `lastIndex` cannot leak.
 */
function heldOutIdPattern(scope: EvidenceScope | undefined, global: boolean): RegExp | undefined {
  if (scope === undefined || scope.corpusTaskIds === undefined) return undefined;
  const hidden = [...scope.corpusTaskIds]
    .filter((id) => id.length > 0 && !scope.trainTaskIds.has(id))
    .sort((a, b) => b.length - a.length);
  if (hidden.length === 0) return undefined;
  return new RegExp(`(?<![\\w.-])(?:${hidden.map(escapeRegExp).join('|')})(?![\\w.-])`, global ? 'g' : '');
}

/** A text scrubber for the ids the evolver may not see. */
export function heldOutScrubber(scope: EvidenceScope | undefined): (text: string) => string {
  const pattern = heldOutIdPattern(scope, true);
  return pattern === undefined ? (text) => text : (text) => text.replace(pattern, HELD_OUT_MENTION);
}

/**
 * R2-L4: does a raw graph row name a held-out task anywhere in its text? An older graph can hold a
 * row that never stamped `goldenTaskId`; scrubbing the id would leave the rest of the sentence —
 * the held-out task's content — in the planner's evidence, so the row itself is dropped.
 */
function heldOutMention(scope: EvidenceScope | undefined): (raw: Record<string, unknown>) => boolean {
  const pattern = heldOutIdPattern(scope, false);
  if (pattern === undefined) return () => false;
  return (raw) => {
    const texts = [String(raw['n.label'] ?? '')];
    for (const value of Object.values(parseProps(raw))) {
      if (typeof value === 'string') texts.push(value);
    }
    return texts.some((text) => pattern.test(text));
  };
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

export async function digestEvidence(
  graph: MemoryGraph, failureLimit = 20, scope?: EvidenceScope,
): Promise<Digest> {
  // `LIMIT` is one of the two positions Cypher cannot bind, so the limit is a validated literal.
  const limit = intLiteral(failureLimit, 'failureLimit');
  // R2-L4: the held-out rows are dropped after the read, so the window must be wider than the
  // digest needs — otherwise a pre-fix graph full of held-out rows starves the train evidence out
  // of it. The read is capped at ten times the requested window and the result is sliced back.
  const readLimit = intLiteral(failureLimit * 10, 'failureLimit * 10');
  const errors: string[] = [];
  const scrub = heldOutScrubber(scope);
  const mentionsHeldOut = heldOutMention(scope);
  const isTrain = (id: unknown): boolean =>
    typeof id === 'string' && (scope === undefined || scope.trainTaskIds.has(id));

  const goldenRows = await readRows(
    graph, 'golden history',
    'MATCH (n:MemoryNode) WHERE n.kind = \'GoldenResult\' RETURN n.label, n.properties ORDER BY n.created_at DESC LIMIT 50',
    errors,
  );
  const goldenHistory: GoldenHistoryRow[] = goldenRows
    // R2-H2: a row that does not say `train` is a full-corpus run (which measured the held-out
    // tasks too) or an older row; a row stamped with another split definition is another corpus.
    // Neither is evidence this run may read.
    .filter((raw) => {
      if (scope === undefined) return true;
      const props = parseProps(raw);
      if (props['split'] !== 'train') return false;
      const sha = props['splits_sha'];
      return typeof sha !== 'string' || scope.splitsSha === undefined || sha === scope.splitsSha;
    })
    .map((raw) => {
      const props = parseProps(raw);
      // `ScoreRecorder` writes every task's verdict beside the score. The ids of the ones that did
      // not pass are what a proposal can target, so the digest carries them rather than leaving the
      // planner to subtract two counts.
      const perTask = Array.isArray(props['perTask']) ? (props['perTask'] as unknown[]) : [];
      const failed = perTask
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .filter((t) => t['passed'] === false)
        .map((t) => String(t['taskId'] ?? ''))
        .filter(isTrain);
      // Both lists are intersected with the train set: a row that passed the split/sha check can
      // still carry a stray id, and the counts are recounted rather than trusted.
      const solved = (Array.isArray(props['solved']) ? (props['solved'] as string[]) : []).filter(isTrain);
      const total = scope === undefined
        ? Number(props['total'] ?? 0)
        : perTask.length > 0
          ? perTask.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
            .filter((t) => isTrain(t['taskId'])).length
          : scope.trainTaskIds.size;
      return {
        harnessId: String(props['harnessId'] ?? ''),
        harnessSha: String(props['harness_sha'] ?? ''),
        solved,
        failed,
        total,
        ranAt: String(props['ranAt'] ?? ''),
        ...(typeof props['split'] === 'string' ? { split: props['split'] } : {}),
      };
    });

  // WP-3.7a MED-1, second layer: a row written by an older version may hold an unmasked reason,
  // and this text reaches the planner's prompt. Mask on the way out as well as on the way in.
  // R2-H2: and scrub it of every id the evolver may not see, on every surface — a refusal's reason
  // quotes the task it refused, a security summary quotes the file, a note quotes both.
  const masked = (text: string): string => scrub(redactEvidenceText(text));
  const maskProps = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).map(
      ([key, value]) => [key, typeof value === 'string' ? masked(value) : value],
    ));

  const failureRows = await readRows(
    graph, 'failures',
    `MATCH (n:MemoryNode) WHERE n.kind = 'Failure' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT ${readLimit}`,
    errors,
  );
  const currentFailures: FailureRow[] = failureRows
    // R2-L4: a failure that says which golden task it belongs to is kept only for a train task;
    // one with no id that still names a held-out task in its text is dropped whole. Scrubbing the
    // id would keep the rest of the sentence, which is the held-out task's content.
    .filter((raw) => {
      const id = parseProps(raw)['goldenTaskId'];
      return id === undefined ? !mentionsHeldOut(raw) : isTrain(id);
    })
    .map((raw) => ({
      label: masked(String(raw['n.label'] ?? '')),
      properties: maskProps(parseProps(raw)),
      runId: String(raw['n.run_id'] ?? ''),
    }))
    .slice(0, failureLimit);

  // WP-3.7a MED-2, R2-L2: the graph may still hold `Allow` events written before the engine stopped
  // recording them. The filter is in the query — on the label, which is a column — so no number of
  // newer Allows can starve an older refusal out of the window. The events are newest-first and the
  // query itself caps the result at `failureLimit`. A client-side filter stays as a backstop for a
  // row whose label was written by something other than this engine's `recordEvent`.
  const policyRows = await readRows(
    graph, 'policy events',
    `MATCH (n:MemoryNode) WHERE n.kind = 'PolicyEvent' AND NOT n.label STARTS WITH 'policy Allow' RETURN n.label, n.properties, n.run_id ORDER BY n.created_at DESC LIMIT ${readLimit}`,
    errors,
  );
  const policyEvents: FailureRow[] = policyRows
    // R2-H2: a refusal that belongs to a held-out task is not evidence about the harness. It is
    // dropped, not just scrubbed: the ids are gone, but a train-looking refusal is still a hint.
    // R2-L4: and a row with no id that names a held-out task in its text is dropped whole, for the
    // same reason the id alone is not enough to keep it.
    .filter((raw) => {
      const id = parseProps(raw)['goldenTaskId'];
      return id === undefined ? !mentionsHeldOut(raw) : isTrain(id);
    })
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
