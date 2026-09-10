import type { HarnessConfig } from '@maf/harness-config';
import { seesawDecision } from '@maf/eval-harness';
import type { GoldenSuiteResult } from '@maf/eval-harness';
import type { ChangeManifest } from './edits.js';
import { screenInstructionText } from './screening.js';

/**
 * The Deterministic Gate (plan §6.2 step 5). LLMs propose; this gate decides.
 * Stages in order; first failure rejects with the reason attached.
 */

export type GateDecision =
  | { verdict: 'ship';   improvements: string[] }
  | { verdict: 'reject'; stage: string; reason: string }
  | { verdict: 'needs-approval'; reason: string };

export interface GateContext {
  manifest: ChangeManifest;
  candidate: HarnessConfig;
  current: HarnessConfig;
  currentScores: GoldenSuiteResult;
  candidateScores: GoldenSuiteResult;
  /** Known ids in the base tool registry (for allowlist ⊆ check). */
  knownToolIds: ReadonlySet<string>;
  /** Processor names resolvable by the static registry. */
  knownProcessorNames: ReadonlySet<string>;
  /** Installed adapter models for retarget bounds (empty = unconstrained). */
  knownModels?: ReadonlySet<string>;
  /** Roles whose prompts never change without human approval. */
  safetyAdjacentRoles?: ReadonlySet<string>;
  /** Golden task ids whose verifiers are all llm-judge (rule e needs this). */
  judgeOnlyTaskIds?: ReadonlySet<string>;
}

/** Gate rule e: improvements resting only on llm-judge verdicts never ship alone (plan §6.1). */
function judgeOnlyImprovement(ctx: GateContext): boolean {
  const judgeIds = ctx.judgeOnlyTaskIds ?? new Set<string>();
  const currentSolved = new Set(ctx.currentScores.solvedTaskIds);
  const improved = ctx.candidateScores.solvedTaskIds.filter((id) => !currentSolved.has(id));
  if (improved.length === 0) return false;
  // If ANY improved task has a non-judge verifier, the improvement is grounded.
  return improved.every((id) => judgeIds.has(id));
}

export function gateEvaluate(ctx: GateContext): GateDecision {
  const { manifest, candidate, current } = ctx;

  // ── stage b: structural invariants ──
  const currentRoles = new Set(current.roleSet.roles.map((r) => r.role));
  for (const role of candidate.roleSet.roles) {
    if (!currentRoles.has(role.role))
      return { verdict: 'reject', stage: 'b-invariants', reason: `candidate adds unknown role "${role.role}"` };
    for (const t of role.allowedTools) {
      if (!ctx.knownToolIds.has(t))
        return { verdict: 'reject', stage: 'b-invariants', reason: `role "${role.role}" allows unknown tool "${t}"` };
    }
    if (role.allowedTools.length === 0 && (current.roleSet.roles.find((r) => r.role === role.role)?.allowedTools.length ?? 0) > 0)
      return { verdict: 'reject', stage: 'b-invariants', reason: `role "${role.role}" would lose its entire tool surface` };
  }
  for (const ref of candidate.processorBundles) {
    if (!ctx.knownProcessorNames.has(ref.name))
      return { verdict: 'reject', stage: 'b-invariants', reason: `unknown processor "${ref.name}"` };
  }
  if (manifest.edit.kind === 'retarget_model' && ctx.knownModels && ctx.knownModels.size > 0) {
    if (!ctx.knownModels.has(manifest.edit.model))
      return { verdict: 'reject', stage: 'b-invariants', reason: `model "${manifest.edit.model}" not available` };
  }

  // ── stage b2: instruction screening (§10.1 — before ANY evaluation spend) ──
  if (manifest.edit.kind === 'edit_role_prompt') {
    const screening = screenInstructionText(manifest.edit.newPrompt);
    if (!screening.ok)
      return { verdict: 'reject', stage: 'b2-instruction-screening', reason: screening.findings.join(', ') };
  }

  // ── stage b3: human approval for sensitive mutations (plan §6.3 amended) ──
  const safetyAdjacent = ctx.safetyAdjacentRoles ?? new Set(['security', 'reviewer']);
  if ('role' in manifest.edit && safetyAdjacent.has(manifest.edit.role)) {
    return {
      verdict: 'needs-approval',
      reason: `edit targets safety-adjacent role "${manifest.edit.role}" (§6.3: prompt/config edits here require operator approval)`,
    };
  }

  // ── stage d: seesaw (regression check) — evaluation artifacts were produced by the caller ──
  const seesaw = seesawDecision(ctx.currentScores, ctx.candidateScores);
  if (seesaw.kind === 'reject')
    return { verdict: 'reject', stage: 'd-seesaw', reason: `regresses: ${seesaw.regressions.join(', ')}` };

  // ── stage e: must improve ≥1 target cluster; llm-judge-only never ships alone ──
  if (seesaw.kind === 'no-change')
    return { verdict: 'reject', stage: 'e-improvement', reason: 'no golden-suite improvement' };
  if (judgeOnlyImprovement(ctx))
    return {
      verdict: 'needs-approval',
      reason: 'improvement rests on llm-judge verdicts only — requires human sign-off (plan §6.1 gate rule e)',
    };

  return { verdict: 'ship', improvements: seesaw.improvements };
}
