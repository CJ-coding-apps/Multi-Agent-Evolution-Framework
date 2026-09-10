import type { RunId } from '@maf/types';
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
import { gateEvaluate } from './gate.js';
import type { GateDecision } from './gate.js';

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
  knownProcessorNames: ReadonlySet<string>;
  knownModels?: ReadonlySet<string>;
  safetyAdjacentRoles?: ReadonlySet<string>;
  judgeOnlyTaskIds?: ReadonlySet<string>;
  /** When false (default), sensitive edits are archived without evaluation. */
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

    // ── 5. Evolver: apply the FINAL manifest → candidate → smoke test (fail fast) ──
    const finalCandidate = applyEdit(base, manifest.edit, `${base.id}-r${round + 1}`);
    try {
      const smokeTarget = manifest.targetTasks[0];
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
      manifest, candidate: finalCandidate, current: base,
      currentScores: baseline, candidateScores,
      knownToolIds: opts.knownToolIds,
      knownProcessorNames: opts.knownProcessorNames,
      safetyAdjacentRoles: safetyAdjacent,
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
