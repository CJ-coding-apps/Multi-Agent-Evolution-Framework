import type { PermissionLevel, RunId } from '@maf/types';
import type { HarnessConfig } from '@maf/harness-config';
import type { GoldenSuiteResult } from '@maf/eval-harness';
import type { MemoryGraph } from '@maf/memory-graph';
import { digestEvidence, isEmptyDigest } from './digester.js';
import type { Digest } from './digester.js';
import { applyEdit, ManifestError } from './edits.js';
import type { ChangeManifest } from './edits.js';
import {
  PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt, parsePlannerResponse,
} from './planner.js';
import type { CurrentHarnessStatus, HistoryLabel, MetaGenerate, RoleCatalogEntry } from './planner.js';
import { gateEvaluate, gateStatic } from './gate.js';
import type { GateDecision, GateVeto } from './gate.js';

export interface EvolveRoundRecord {
  round: number;
  manifest?: ChangeManifest;
  gate?: GateDecision;
  outcome: 'ship' | 'reject' | 'no-op' | 'needs-approval' | 'planner-error' | 'smoke-failed' | 'critic-reject' | 'record-failed';
  note: string;
  /**
   * The evaluation a flag-on sensitive edit paid for and did not act on (WP-3.9 K1). The ruling
   * makes `--approve-sensitive` permission to SPEND on the evaluation, not to ship: the candidate
   * reaches the critic, the smoke test and the golden suite, its verdict is still `needs-approval`,
   * and this is the evidence the operator applies by hand (`maf harness set-current <candidateSha>`).
   */
  evaluation?: SensitiveEvaluation;
}

/** What the evaluation of a sensitive candidate measured, kept with the stored candidate. */
export interface SensitiveEvaluation {
  candidateSha: string;
  currentScores: GoldenSuiteResult;
  candidateScores: GoldenSuiteResult;
  /**
   * WP-3.7a R2-L4: set when the loop paid for this evaluation but the recorder could not write it.
   * `candidateScores` is what the run measured; it is not in the graph, so the report says so.
   */
  unrecorded?: true;
}

export interface EvolveOptions {
  baseHarness: HarnessConfig;
  runId: RunId;
  maxRounds?: number;              // default 10
  patience?: number;               // default 3
  /** LLM meta-agent call (planner AND critic). Injected; mock in tests. */
  metaGenerate: MetaGenerate;
  /** Run-scoped memory graph for evidence digestion + round recording. */
  graph: MemoryGraph;
  /** Full golden suite under an arbitrary harness. Injected. */
  runGoldens: (harness: HarnessConfig) => Promise<GoldenSuiteResult>;
  /**
   * Writes one golden run's result as evidence — the same recorder `maf goldens run` uses.
   *
   * WP-3.7 amendment item 1: without this the loop digests a graph it never writes to, so the
   * planner sees `(no golden history)` in every round and `no_op` is the correct answer. It is
   * called for the baseline and for every candidate, before the next round's digest is taken.
   * A failure to record propagates: continuing would silently run blind, which is the defect.
   */
  recordGoldens?: (result: GoldenSuiteResult) => Promise<void>;
  /** Called for every round as it is recorded, so a caller can surface what the loop did. */
  onRound?: (round: EvolveRoundRecord) => void;
  /** One-task smoke evaluation (fail fast on crash). Injected. */
  runSmoke: (harness: HarnessConfig, taskId: string) => Promise<void>;
  /** What to do when a candidate ships (persist + setCurrent etc). */
  onShip: (candidate: HarnessConfig, improvements: string[]) => Promise<void>;
  /**
   * Persist a `needs-approval` candidate WITHOUT making it current (WP-3.9 M1). The candidate a
   * flag-on sensitive edit paid to evaluate is saved so the human who reads it can apply it with
   * `maf harness set-current <candidateSha>`; applying it is the human's act, so this callback must
   * not move CURRENT. Absent (tests, embedders) means nothing is stored.
   */
  storeCandidate?: (candidate: HarnessConfig, evaluation: SensitiveEvaluation) => Promise<void>;
  roleCatalog: RoleCatalogEntry[];
  knownToolIds: ReadonlySet<string>;
  /**
   * Permission level per known tool (WP-3.9 F7: required). The gate's widening rule is the
   * evolver's one defence against turning a reader into a writer, and while this was optional a
   * caller that omitted it skipped the rule silently. A tool the map does not name is treated as
   * `dangerous`, never as harmless.
   */
  toolPermissions: ReadonlyMap<string, PermissionLevel>;
  knownProcessorNames: ReadonlySet<string>;
  knownModels?: ReadonlySet<string>;
  safetyAdjacentRoles?: ReadonlySet<string>;
  judgeOnlyTaskIds?: ReadonlySet<string>;
  /**
   * Permission to spend to evaluate a sensitive edit, not to ship it (WP-3.9 K1). When true, an
   * edit targeting a safety-adjacent role runs the full evaluation — critic, smoke test, golden
   * suite — and its verdict is still `needs-approval`: the candidate is stored with its evaluation
   * and applied only by a human (`maf harness set-current <candidateSha>`). When false (default) it is archived
   * unevaluated as `needs-approval`. It does not approve a tool widening either: stage b4 asks the
   * operator whatever this says.
   */
  approveSensitive?: boolean;
}

export interface EvolveReport {
  rounds: EvolveRoundRecord[];
  finalHarness: HarnessConfig;
  ships: number;
  /**
   * `record-failed` is a stop the caller must report (WP-3.7a L2): a golden run was paid for and
   * its result could not be written as evidence. The report still carries every round up to that
   * point; `error` says what could not be recorded and how many rounds completed.
   */
  stopReason: 'budget' | 'patience' | 'record-failed';
  /** Present exactly when `stopReason` is `record-failed`. */
  error?: string;
}

const CRITIC_SYSTEM_PROMPT = `You are the MAF harness evolution critic. Compare the change manifest against the
evidence: does the expected improvement follow from the traces? Does the edit risk non-local effects through
shared components? Respond with exactly one fenced JSON block: {"verdict":"ship"|"revise"|"reject","notes":"..."}.
"revise" is allowed at most once per manifest.`;

function parseCriticVerdict(text: string): { verdict: 'ship' | 'revise' | 'reject'; notes: string } {
  const m = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidate = m ? m[1]! : text.trim();
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const v = String(parsed['verdict'] ?? '');
    if (v === 'ship' || v === 'revise' || v === 'reject') {
      return { verdict: v, notes: String(parsed['notes'] ?? '') };
    }
  } catch { /* fall through */ }
  return { verdict: 'reject', notes: 'unparseable critic response — fail closed' };
}

async function recordRound(
  graph: MemoryGraph, runId: RunId, round: EvolveRoundRecord, harnessSha: string,
): Promise<void> {
  await graph.addNode({
    kind: 'EvolutionRound',
    label: `evolution round ${round.round}: ${round.outcome}`,
    properties: {
      round: round.round, outcome: round.outcome, note: round.note,
      harness_sha: harnessSha,
      manifest: round.manifest ?? null, gate: round.gate ?? null,
      // A sensitive candidate's evaluation is part of the stored candidate (K1): the operator
      // applies it by hand, and the evidence must outlive this process.
      ...(round.evaluation ? { evaluation: round.evaluation } : {}),
    },
    runId,
  });
}

function baselineFromHistory(history: Digest['goldenHistory'], harness: HarnessConfig): GoldenSuiteResult | undefined {
  const row = history.find((h) => h.harnessSha === harness.sha);
  if (!row) return undefined;
  return {
    harnessSha: row.harnessSha, harnessId: row.harnessId,
    tasks: [], solvedTaskIds: row.solved, ranAt: row.ranAt,
  };
}

/** What the planner is told about the harness in force (MED-3): the base, never a candidate. */
function currentStatus(
  digest: Digest, base: HarnessConfig, baseline: GoldenSuiteResult | undefined,
): CurrentHarnessStatus {
  const row = digest.goldenHistory.find((h) => h.harnessSha === base.sha);
  if (row !== undefined) {
    return { id: base.id, sha: base.sha, solved: row.solved, total: row.total, failed: row.failed };
  }
  if (baseline !== undefined) {
    return {
      id: base.id, sha: base.sha,
      solved: baseline.solvedTaskIds,
      total: baseline.tasks.length,
      // A baseline rebuilt from history carries no per-task rows; only a run this loop paid for has
      // them, and then this is the same list the digest row would have carried.
      failed: baseline.tasks.filter((t) => !t.passed).map((t) => t.taskId),
    };
  }
  return { id: base.id, sha: base.sha, solved: [], total: 0, failed: [] };
}

/**
 * A golden run this loop paid for whose result could not be written as evidence. It stops the run
 * (continuing would evolve from a graph the loop is not filling) and carries the sentence the CLI
 * prints and the report keeps.
 */
class RecordFailedError extends Error {
  /** The run that was paid for and could not be written; the partial report keeps it. */
  constructor(message: string, readonly result: GoldenSuiteResult) {
    super(message);
  }
}

/**
 * The partial report a `RecordFailedError` produces, or undefined for any other error (which keeps
 * propagating). Every round already paid for is in `rounds`; the harness in force is `base`.
 */
function recordFailureReport(
  err: unknown, rounds: EvolveRoundRecord[], base: HarnessConfig, ships: number,
): EvolveReport | undefined {
  if (!(err instanceof RecordFailedError)) return undefined;
  return { rounds, finalHarness: base, ships, stopReason: 'record-failed', error: err.message };
}

const CRASH_OK = (e: unknown): e is Error => e instanceof Error;

/** The safety-adjacent role an edit targets, or undefined when it targets none (or no role). */
function sensitiveRoleOf(
  manifest: ChangeManifest, safetyAdjacent: ReadonlySet<string>,
): string | undefined {
  return 'role' in manifest.edit && safetyAdjacent.has(manifest.edit.role)
    ? manifest.edit.role
    : undefined;
}

/**
 * The AEGIS-lite evolution loop (plan §6.2). Selective invocation: no_digest
 * signal, planner no-op, empty candidates, and smoke crashes all end rounds
 * cheaply; only gate-approved candidates ever reach onShip.
 */
export async function evolve(opts: EvolveOptions): Promise<EvolveReport> {
  let base = opts.baseHarness;
  const maxRounds = opts.maxRounds ?? 10;
  const patience = opts.patience ?? 3;
  const safetyAdjacent = opts.safetyAdjacentRoles ?? new Set(['security', 'reviewer']);
  const rounds: EvolveRoundRecord[] = [];
  let idle = 0;
  let ships = 0;
  let stopReason: EvolveReport['stopReason'] = 'budget';

  let baseline: GoldenSuiteResult | undefined;
  // What each golden row this loop caused actually is (R2-L1). Rows with no entry are another
  // session's or another harness's; the prompt calls them `earlier result`, never "rejected".
  const historyLabels = new Map<string, HistoryLabel>();

  // Every golden run the loop pays for is evidence for the rounds after it (WP-3.7 amendment 1).
  // Recording before returning means the next digest reads it; a throw is not swallowed, because
  // the alternative is a loop that keeps proposing from an empty graph and calling that no_op.
  const evaluate = async (harness: HarnessConfig): Promise<GoldenSuiteResult> => {
    const result = await opts.runGoldens(harness);
    if (opts.recordGoldens) {
      try {
        await opts.recordGoldens(result);
      } catch (err) {
        // L2: the run was paid for. Say which result was lost, how much of the evolution is still
        // in the report, and why — rather than a bare graph error from inside a recorder.
        throw new RecordFailedError(
          `could not record the golden result for ${result.harnessId} (${result.harnessSha})`
          + `; rounds completed: ${rounds.length}`
          + `; ${err instanceof Error ? err.message : String(err)}`,
          result,
        );
      }
    }
    return result;
  };

  for (let round = 0; round < maxRounds; round++) {
    const rec = (r: Omit<EvolveRoundRecord, 'round'>): EvolveRoundRecord => ({ round, ...r });
    const record = async (r: EvolveRoundRecord): Promise<void> => {
      rounds.push(r);
      opts.onRound?.(r);
      // Recording is best-effort: a graph hiccup must never abort evolution (L4).
      // The failure is surfaced in the round note rather than thrown.
      try {
        await recordRound(opts.graph, opts.runId, r, base.sha);
      } catch (err) {
        r.note = `${r.note} [graph-record-failed: ${err instanceof Error ? err.message : String(err)}]`;
      }
    };

    // Every gate stage that is free (WP-3.9 G3/G4): the candidate is built and the invariants and
    // widening rule are asked, with no model call and no evaluation. Called as soon as a manifest
    // exists and again on the final one, because a critic revision can introduce either defect.
    const freeCheck = (m: ChangeManifest): { candidate: HarnessConfig } | { veto: GateVeto } => {
      let candidate: HarnessConfig;
      try {
        candidate = applyEdit(base, m.edit, `${base.id}-r${round + 1}`);
      } catch (err) {
        // An edit the harness cannot express is a malformed candidate, not a reason to abort the
        // loop; the invariant stage is where a refusal belongs, and it names what it refused.
        if (err instanceof ManifestError)
          return { veto: { verdict: 'reject', stage: 'b-invariants', reason: err.message } };
        throw err;
      }
      const veto = gateStatic({
        manifest: m, candidate, current: base,
        knownToolIds: opts.knownToolIds,
        toolPermissions: opts.toolPermissions,
        knownProcessorNames: opts.knownProcessorNames,
        safetyAdjacentRoles: safetyAdjacent,
        approveSensitive: opts.approveSensitive === true,
        ...(opts.knownModels ? { knownModels: opts.knownModels } : {}),
      });
      return veto ? { veto } : { candidate };
    };

    // ── 1. Digester ──
    let digest = await digestEvidence(opts.graph);
    if (round === 0) baseline = baselineFromHistory(digest.goldenHistory, base);
    if (!baseline) {
      try {
        baseline = await evaluate(base);
      } catch (err) {
        const stopped = recordFailureReport(err, rounds, base, ships);
        if (stopped !== undefined) return stopped;
        throw err;
      }
      // L1: the baseline was just paid for, so it is evidence for THIS round's planner. Without
      // this, round 1 planned from the empty digest it read before running and burned a tick.
      digest = await digestEvidence(opts.graph);
    }
    const current = currentStatus(digest, base, baseline);

    // ── 2. Planner ──
    let manifest: ChangeManifest | undefined;
    try {
      const response = await opts.metaGenerate(
        PLANNER_SYSTEM_PROMPT,
        buildPlannerUserPrompt(
          digest, opts.roleCatalog, [...(opts.knownProcessorNames ?? [])], current, historyLabels,
        ),
      );
      manifest = parsePlannerResponse(response);
    } catch (err) {
      if (err instanceof ManifestError) {
        idle++;
        await record(rec({ outcome: 'planner-error', note: err.message }));
        if (idle >= patience) { stopReason = 'patience'; break; }
        continue;
      }
      throw err;
    }
    if (!manifest) {
      idle++;
      // Amendment item 2: an empty digest is a state the operator should see named, not the
      // silent `no_op` that made six live rounds look like a planner preference.
      await record(rec({
        outcome: 'no-op',
        note: isEmptyDigest(digest) ? 'no evidence to propose from' : 'planner returned no_op',
      }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }

    // ── 3. Pre-evaluation approval routing (§6.3: approve BEFORE evaluation spend) ──
    // Without the flag a sensitive edit is archived before anything is spent. With it the operator
    // has paid for the evaluation — not for the ship — so the round continues and step 6 downgrades
    // the verdict (K1).
    const sensitiveRole = sensitiveRoleOf(manifest, safetyAdjacent);
    if (sensitiveRole !== undefined && !opts.approveSensitive) {
      idle++;
      await record(rec({
        manifest, outcome: 'needs-approval',
        note: `targets safety-adjacent role "${sensitiveRole}"; archived unevaluated`,
      }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }

    // ── 3b. The free gate stages, the moment the candidate manifest exists (WP-3.9 G3/G4) ──
    // The proposal itself is a model call and cannot be avoided; the critic, the smoke test and
    // the golden suite are three more, and none of them can change this answer. Running the
    // invariants (an unknown tool id is refused here, naming the tools that exist) and the
    // widening rule now means a manifest that widens a reader into a writer — or names a tool
    // that does not exist — costs one model call and nothing else.
    const proposed = freeCheck(manifest);
    if ('veto' in proposed) {
      const veto = proposed.veto;
      idle++;
      await record(rec({
        manifest, gate: veto,
        outcome: veto.verdict === 'needs-approval' ? 'needs-approval' : 'reject',
        note: veto.verdict === 'reject' ? `${veto.stage}: ${veto.reason}` : veto.reason,
      }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }

    // ── 4. Critic (one revision allowed) — BEFORE building/smoking a candidate,
    //       so step 5 smoke-tests the FINAL (possibly revised) manifest (L5). ──
    let critic = parseCriticVerdict(await opts.metaGenerate(
      CRITIC_SYSTEM_PROMPT,
      `Evidence:\n${JSON.stringify(digest)}\n\nManifest:\n${JSON.stringify(manifest, null, 2)}`,
    ));
    if (critic.verdict === 'revise') {
      const revised = await opts.metaGenerate(
        PLANNER_SYSTEM_PROMPT,
        buildPlannerUserPrompt(
          digest, opts.roleCatalog, [...(opts.knownProcessorNames ?? [])], current, historyLabels,
        )
          + `\n\nCritic revision request: ${critic.notes}\nPrevious manifest: ${JSON.stringify(manifest)}`,
      );
      try {
        manifest = parsePlannerResponse(revised);
      } catch (err) {
        if (err instanceof ManifestError) manifest = undefined; else throw err;
      }
      if (!manifest) {
        idle++;
        await record(rec({ outcome: 'critic-reject', note: `revision failed: ${critic.notes}` }));
        if (idle >= patience) { stopReason = 'patience'; break; }
        continue;
      }
      critic = parseCriticVerdict(await opts.metaGenerate(
        CRITIC_SYSTEM_PROMPT,
        `Evidence:\n${JSON.stringify(digest)}\n\nManifest (revised, final):\n${JSON.stringify(manifest, null, 2)}`,
      ));
    }
    if (critic.verdict === 'reject') {
      idle++;
      await record(rec({ manifest, outcome: 'critic-reject', note: critic.notes }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }

    // ── 5. Evolver: apply the FINAL manifest → candidate → free stages again → smoke ──
    // The critic may have replaced the manifest, so the invariants and the widening rule are asked
    // again about what will actually be smoked: a revision can introduce an unknown tool or a
    // widening the first check never saw. Still no model call and no golden run after the
    // proposal — the critic's own calls are the only ones between the two checks.
    const finalManifest = manifest;
    const finalCheck = freeCheck(finalManifest);
    if ('veto' in finalCheck) {
      const veto = finalCheck.veto;
      idle++;
      await record(rec({
        manifest: finalManifest, gate: veto,
        outcome: veto.verdict === 'needs-approval' ? 'needs-approval' : 'reject',
        note: veto.verdict === 'reject' ? `${veto.stage}: ${veto.reason}` : veto.reason,
      }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }
    const finalCandidate = finalCheck.candidate;
    try {
      const smokeTarget = finalManifest.targetTasks[0];
      if (smokeTarget) await opts.runSmoke(finalCandidate, smokeTarget);
    } catch (err) {
      idle++;
      await record(rec({
        manifest, outcome: 'smoke-failed',
        note: CRASH_OK(err) ? err.message : String(err),
      }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }

    // ── 6. Gate (mandatory, deterministic) ──
    let candidateScores: GoldenSuiteResult;
    try {
      candidateScores = await evaluate(finalCandidate);
    } catch (err) {
      // R2-L4: the in-flight round was paid for, so the partial report says what it held — the
      // manifest and the scores the recorder could not write — instead of dropping it.
      if (err instanceof RecordFailedError) {
        await record(rec({
          manifest: finalManifest,
          outcome: 'record-failed',
          note: `the candidate result for ${err.result.harnessId} (${err.result.harnessSha}) could not be recorded`,
          evaluation: {
            candidateSha: finalCandidate.sha,
            currentScores: baseline,
            candidateScores: err.result,
            unrecorded: true,
          },
        }));
      }
      const stopped = recordFailureReport(err, rounds, base, ships);
      if (stopped !== undefined) return stopped;
      throw err;
    }
    const gate = gateEvaluate({
      manifest: finalManifest, candidate: finalCandidate, current: base,
      currentScores: baseline, candidateScores,
      knownToolIds: opts.knownToolIds,
      toolPermissions: opts.toolPermissions,
      knownProcessorNames: opts.knownProcessorNames,
      safetyAdjacentRoles: safetyAdjacent,
      approveSensitive: opts.approveSensitive === true,
      ...(opts.knownModels ? { knownModels: opts.knownModels } : {}),
      ...(opts.judgeOnlyTaskIds ? { judgeOnlyTaskIds: opts.judgeOnlyTaskIds } : {}),
    });

    // K1: a sensitive edit reaches this point only with the flag, and the gate returns
    // `needs-approval` even when the evaluation would ship. What the evaluation measured is stored
    // with the candidate so the human who applies it (`maf harness set-current <candidateSha>`)
    // sees the evidence. The role is read from the FINAL manifest: the critic may have revised the
    // target role.
    const finalSensitiveRole = sensitiveRoleOf(finalManifest, safetyAdjacent);
    const evaluation: SensitiveEvaluation | undefined =
      finalSensitiveRole !== undefined && gate.verdict === 'needs-approval'
        ? { candidateSha: finalCandidate.sha, currentScores: baseline, candidateScores }
        : undefined;

    // M1: the candidate reaches the store so a human can apply it, but CURRENT stays where it is —
    // applying it is the reader's act. A store failure is reported with the round (the candidate
    // has still been evaluated and the report names what could not be saved), never swallowed.
    let storeNote = '';
    if (evaluation !== undefined && opts.storeCandidate !== undefined) {
      try {
        await opts.storeCandidate(finalCandidate, evaluation);
        storeNote = `; candidate ${finalCandidate.sha} stored, not current — apply it with \`maf harness set-current ${finalCandidate.sha}\``;
      } catch (err) {
        storeNote = `; candidate ${finalCandidate.sha} could not be stored: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (gate.verdict === 'ship') {
      idle = 0;
      ships++;
      await opts.onShip(finalCandidate, gate.improvements);
      await record(rec({ manifest: finalManifest, gate, outcome: 'ship', note: `improves ${gate.improvements.join(', ')}` }));
      // R2-L1: the harness that was in force is now a previous base, not a rejected candidate; the
      // one that replaced it was shipped by this loop. A harness this loop shipped on an earlier
      // round keeps `shipped` — it is not merely the base it started from.
      if (!historyLabels.has(base.sha)) historyLabels.set(base.sha, 'previous base');
      historyLabels.set(finalCandidate.sha, 'shipped');
      base = finalCandidate;
      baseline = candidateScores;
      continue;
    }
    idle++;
    historyLabels.set(
      finalCandidate.sha, gate.verdict === 'needs-approval' ? 'needs approval' : 'rejected',
    );
    await record(rec({
      manifest: finalManifest, gate,
      outcome: gate.verdict === 'needs-approval' ? 'needs-approval' : 'reject',
      note: (gate.verdict === 'reject' ? `${gate.stage}: ${gate.reason}` : gate.reason) + storeNote,
      ...(evaluation ? { evaluation } : {}),
    }));
    if (idle >= patience) { stopReason = 'patience'; break; }
  }

  return { rounds, finalHarness: base, ships, stopReason };
}
