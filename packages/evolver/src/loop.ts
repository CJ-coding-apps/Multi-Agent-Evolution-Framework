import type { PermissionLevel, RunId } from '@maf/types';
import type { HarnessConfig } from '@maf/harness-config';
import type { GoldenSuiteResult } from '@maf/eval-harness';
import type { MemoryGraph } from '@maf/memory-graph';
import { digestEvidence } from './digester.js';
import type { Digest } from './digester.js';
import { applyEdit, ManifestError } from './edits.js';
import type { ChangeManifest } from './edits.js';
import {
  PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt, parsePlannerResponse,
} from './planner.js';
import type { MetaGenerate, RoleCatalogEntry } from './planner.js';
import { gateEvaluate, gateStatic } from './gate.js';
import type { GateDecision, GateVeto } from './gate.js';

export interface EvolveRoundRecord {
  round: number;
  manifest?: ChangeManifest;
  gate?: GateDecision;
  outcome: 'ship' | 'reject' | 'no-op' | 'needs-approval' | 'planner-error' | 'smoke-failed' | 'critic-reject';
  note: string;
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
  /** One-task smoke evaluation (fail fast on crash). Injected. */
  runSmoke: (harness: HarnessConfig, taskId: string) => Promise<void>;
  /** What to do when a candidate ships (persist + setCurrent etc). */
  onShip: (candidate: HarnessConfig, improvements: string[]) => Promise<void>;
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
   * When true, an edit targeting a safety-adjacent role is evaluated in full — critic, smoke test,
   * golden suite — and receives the normal verdict. When false (default) it is archived
   * unevaluated as `needs-approval`. It does not approve a tool widening: stage b4 asks the
   * operator whatever this says.
   */
  approveSensitive?: boolean;
}

export interface EvolveReport {
  rounds: EvolveRoundRecord[];
  finalHarness: HarnessConfig;
  ships: number;
  stopReason: 'budget' | 'patience';
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

const CRASH_OK = (e: unknown): e is Error => e instanceof Error;

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

  for (let round = 0; round < maxRounds; round++) {
    const rec = (r: Omit<EvolveRoundRecord, 'round'>): EvolveRoundRecord => ({ round, ...r });
    const record = async (r: EvolveRoundRecord): Promise<void> => {
      rounds.push(r);
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
    const digest = await digestEvidence(opts.graph);
    if (round === 0) baseline = baselineFromHistory(digest.goldenHistory, base);
    if (!baseline) baseline = await opts.runGoldens(base);

    // ── 2. Planner ──
    let manifest: ChangeManifest | undefined;
    try {
      const response = await opts.metaGenerate(
        PLANNER_SYSTEM_PROMPT,
        buildPlannerUserPrompt(digest, opts.roleCatalog, [...(opts.knownProcessorNames ?? [])]),
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
      await record(rec({ outcome: 'no-op', note: 'planner returned no_op' }));
      if (idle >= patience) { stopReason = 'patience'; break; }
      continue;
    }

    // ── 3. Pre-evaluation approval routing (§6.3: approve BEFORE evaluation spend) ──
    const targetsSensitive = 'role' in manifest.edit && safetyAdjacent.has(manifest.edit.role);
    if (targetsSensitive && !opts.approveSensitive) {
      idle++;
      await record(rec({
        manifest, outcome: 'needs-approval',
        note: `targets safety-adjacent role "${'role' in manifest.edit ? manifest.edit.role : ''}"; archived unevaluated`,
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
        buildPlannerUserPrompt(digest, opts.roleCatalog, [...(opts.knownProcessorNames ?? [])])
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
    const candidateScores = await opts.runGoldens(finalCandidate);
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

    if (gate.verdict === 'ship') {
      idle = 0;
      ships++;
      await opts.onShip(finalCandidate, gate.improvements);
      await record(rec({ manifest, gate, outcome: 'ship', note: `improves ${gate.improvements.join(', ')}` }));
      base = finalCandidate;
      baseline = candidateScores;
      continue;
    }
    idle++;
    await record(rec({
      manifest, gate,
      outcome: gate.verdict === 'needs-approval' ? 'needs-approval' : 'reject',
      note: gate.verdict === 'reject' ? `${gate.stage}: ${gate.reason}` : gate.reason,
    }));
    if (idle >= patience) { stopReason = 'patience'; break; }
  }

  return { rounds, finalHarness: base, ships, stopReason };
}
