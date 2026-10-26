import type { PermissionLevel } from '@maf/types';
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
  /**
   * What each known tool may do. A widening is judged by the tool's own permission level, not by
   * its name: the same edit that adds `fs.read` is harmless and the one that adds `fs.write`
   * hands a role the tree.
   *
   * Required (WP-3.9 F7). It was optional, and an omitted map skipped the widening rule
   * entirely — the one check that stops the evolver turning a reader into a writer failed open
   * for a caller that forgot an argument. A caller must now say what every tool it recognises
   * may do; a tool the map does not know is treated as `dangerous`, never as `read`.
   */
  toolPermissions: ReadonlyMap<string, PermissionLevel>;
  /** Processor names resolvable by the static registry. */
  knownProcessorNames: ReadonlySet<string>;
  /** Installed adapter models for retarget bounds (empty = unconstrained). */
  knownModels?: ReadonlySet<string>;
  /** Roles whose prompts never change without human approval. */
  safetyAdjacentRoles?: ReadonlySet<string>;
  /**
   * The operator has approved edits to safety-adjacent roles for this run (WP-3.9 H1).
   *
   * It changes stage b3 and nothing else: with it set, such an edit is evaluated like any other
   * and its verdict comes from the normal stages; without it, b3 asks the operator before any
   * evaluation spend. Stage b4 never consults it — a tool widening needs approval whatever the
   * operator approved for role prompts.
   */
  approveSensitive?: boolean;
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

/** What a widening says: the one gate verdict that names a decision the operator may make. */
type NeedsApproval = Extract<GateDecision, { verdict: 'needs-approval' }>;

/** A gate context without the evaluation artifacts — what a rule that costs nothing needs. */
export type GateStaticContext = Omit<GateContext, 'currentScores' | 'candidateScores'>;

/**
 * What a stage that costs nothing can say: it refuses the candidate, or it asks the operator.
 * It cannot ship, because shipping is stage e's answer and stage e needs the golden scores.
 */
export type GateVeto = Extract<GateDecision, { verdict: 'reject' }> | NeedsApproval;

/** The levels that make an added tool a widening rather than another way to read. */
const WRITE_LEVELS: ReadonlySet<PermissionLevel> = new Set<PermissionLevel>(['write', 'execute', 'dangerous']);

/**
 * Stage b4, exported (WP-3.9 F7): the widening rule, as a pure function of the manifest and the
 * two harnesses. It costs nothing — no model call, no golden run — so a caller that evaluates a
 * candidate asks it before spending anything. The loop reaches it through `gateStatic`, which runs
 * the invariants first: on its own this function treats a tool the permission map does not name as
 * `dangerous`, so a caller that skips stage b would turn an unknown id into an approval request.
 *
 * The widening is the candidate's surface minus the current one (WP-3.9 F8), not the manifest's
 * `add` list: `add` is what the model claims, and a tool the role already holds is not something
 * the edit granted. Taken from the two role sets, an `add` of a tool that is already there (or an
 * add cancelled by a remove) is not a widening, and a `remove` cannot hide a tool the candidate
 * still gains.
 */
export function gateWidening(ctx: GateStaticContext): NeedsApproval | undefined {
  const { manifest, candidate, current } = ctx;
  if (manifest.edit.kind !== 'adjust_tool_allowlist') return undefined;
  const role = manifest.edit.role;
  const surfaceOf = (harness: HarnessConfig): ReadonlySet<string> =>
    new Set(harness.roleSet.roles.find((r) => r.role === role)?.allowedTools ?? []);
  const before = surfaceOf(current);
  const widened = [...surfaceOf(candidate)].filter((tool) => {
    if (before.has(tool)) return false;
    // A level the map does not name is not assumed harmless: the gate refuses what it cannot
    // classify rather than granting it.
    return WRITE_LEVELS.has(ctx.toolPermissions.get(tool) ?? 'dangerous');
  });
  if (widened.length === 0) return undefined;
  return {
    verdict: 'needs-approval',
    reason: `b4-write-tool-widening: edit grants ${widened.map((t) => JSON.stringify(t)).join(', ')} ` +
      `to role "${role}"; a write, execute or dangerous tool may be added to a role only by ` +
      'operator approval (§6.3)',
  };
}

/**
 * Stages b, b2, b3 and b4 — every gate stage that is a pure function of the manifest, the two
 * harnesses and the registries. Exported (WP-3.9 G3/G4) so the loop runs them the moment a
 * candidate manifest exists: before the critic call, the smoke test and the golden suite, not
 * after them. `gateEvaluate` runs the same function, so a candidate the loop waves through cannot
 * be refused later for a reason this stage would have given, and vice versa.
 *
 * The order inside it is the ruling's: **invariants first, then the widening rule**. An unknown
 * tool id is a malformed candidate, not a widening — `gateWidening` treats a tool the permission
 * map does not name as `dangerous` and would send it to the operator as an approval request, so
 * stage b must refuse it before b4 ever sees it, and its refusal names the tools that do exist
 * (fail closed on the unknown, §1).
 */
export function gateStatic(ctx: GateStaticContext): GateVeto | undefined {
  const { manifest, candidate, current } = ctx;

  // ── stage b: structural invariants ──
  const currentRoles = new Set(current.roleSet.roles.map((r) => r.role));
  for (const role of candidate.roleSet.roles) {
    if (!currentRoles.has(role.role))
      return { verdict: 'reject', stage: 'b-invariants', reason: `candidate adds unknown role "${role.role}"` };
    for (const t of role.allowedTools) {
      if (!ctx.knownToolIds.has(t))
        return {
          verdict: 'reject', stage: 'b-invariants',
          reason: `role "${role.role}" allows unknown tool "${t}" — refusing a malformed candidate ` +
            `rather than judging it (known tools: ${[...ctx.knownToolIds].sort().join(', ')})`,
        };
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
  // The approval is `approveSensitive`, not the mere existence of this stage: it says the operator
  // has already decided that edits to these roles may be evaluated, and with it set the candidate
  // goes through the critic, the smoke test and the golden suite like any other. Without it the
  // answer is `needs-approval` and nothing is evaluated. Before WP-3.9 H1 this stage fired
  // unconditionally, so the flag had no effect on the verdict — a caller passed the approval and
  // was still stopped here, before the critic.
  const safetyAdjacent = ctx.safetyAdjacentRoles ?? new Set(['security', 'reviewer']);
  if (!ctx.approveSensitive && 'role' in manifest.edit && safetyAdjacent.has(manifest.edit.role)) {
    return {
      verdict: 'needs-approval',
      reason: `edit targets safety-adjacent role "${manifest.edit.role}" (§6.3: prompt/config edits here require operator approval)`,
    };
  }

  // ── stage b4: widening an ordinary role into a writer needs the operator ──
  // Either the edit targets an ordinary role, or the operator pre-approved sensitive edits and b3
  // let it through; a safety-adjacent role's allowlist can widen, and that still needs the
  // operator. Widening a role's surface with a tool that can
  // change the tree or run code is the mutation the evolver may not perform on its own: it may
  // tune a prompt, a budget or a model, but it may not make a reader a writer. The verdict is
  // `needs-approval` rather than `reject` (WP-3.9 F8): the operator may grant the tool, and a
  // candidate that ships itself still cannot.
  return gateWidening(ctx);
}

export function gateEvaluate(ctx: GateContext): GateDecision {
  // Every stage that costs nothing, first: the loop already ran these before the critic, and a
  // caller that only has scores to add gets the same answers in the same order.
  const veto = gateStatic(ctx);
  if (veto) return veto;

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
