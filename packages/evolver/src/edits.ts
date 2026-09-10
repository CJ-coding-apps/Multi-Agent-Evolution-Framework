import type { HarnessConfig } from '@maf/harness-config';
import { mintHarnessConfig } from '@maf/harness-config';

/**
 * The bounded mutation surface (plan §6.1). Anything not expressible as one of
 * these edit kinds is rejected at parse — the policy engine, security gate,
 * attestation config, tool implementations, and adapter code are not reachable.
 */

export type HarnessEdit =
  | { kind: 'edit_role_prompt';       role: string; newPrompt: string; rationale: string }
  | { kind: 'adjust_tool_allowlist';  role: string; add: string[]; remove: string[] }
  | { kind: 'retarget_model';         role: string; model: string }
  | { kind: 'tune_role_budgets';      role: string; maxToolIterations?: number; tokenBudget?: number; timeoutMs?: number }
  | { kind: 'add_processor';          bundle: { name: string; config?: Record<string, unknown> } }
  | { kind: 'rebind_planner_recall';  pastFailuresLimit?: number; lcmGrepBudgetTokens?: number };

export interface ChangeManifest {
  edit: HarnessEdit;
  /** What should improve, in the meta-agent's words. */
  expectedImprovement: string;
  /** Golden task ids this edit targets. */
  targetTasks: string[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const EDIT_KINDS = new Set([
  'edit_role_prompt', 'adjust_tool_allowlist', 'retarget_model',
  'tune_role_budgets', 'add_processor', 'rebind_planner_recall',
]);

const ALLOWED_FIELDS: Record<HarnessEdit['kind'], readonly string[]> = {
  edit_role_prompt:      ['kind', 'role', 'newPrompt', 'rationale'],
  adjust_tool_allowlist: ['kind', 'role', 'add', 'remove'],
  retarget_model:        ['kind', 'role', 'model'],
  tune_role_budgets:     ['kind', 'role', 'maxToolIterations', 'tokenBudget', 'timeoutMs'],
  add_processor:         ['kind', 'bundle'],
  rebind_planner_recall: ['kind', 'pastFailuresLimit', 'lcmGrepBudgetTokens'],
};

/** Parse + validate a manifest at the boundary. Throws ManifestError. */
export function assertChangeManifest(x: unknown): asserts x is ChangeManifest {
  if (!x || typeof x !== 'object') throw new ManifestError('manifest must be an object');
  const o = x as Record<string, unknown>;
  if (typeof o['expectedImprovement'] !== 'string' || o['expectedImprovement'].length === 0)
    throw new ManifestError('expectedImprovement required');
  if (!Array.isArray(o['targetTasks'])) throw new ManifestError('targetTasks must be an array');

  const rawEdit = o['edit'];
  if (!rawEdit || typeof rawEdit !== 'object') throw new ManifestError('edit must be an object');
  const edit = rawEdit as Record<string, unknown>;
  if (typeof edit['kind'] !== 'string' || !EDIT_KINDS.has(edit['kind'] as string))
    throw new ManifestError(`edit.kind must be one of: ${[...EDIT_KINDS].join(', ')}`);
  const kind = edit['kind'] as HarnessEdit['kind'];

  // Hard exclusions live in the parser, not the prompt: unknown edit fields
  // are rejected (no smuggling policyRules, gate thresholds, etc.).
  const allowed = ALLOWED_FIELDS[kind]!;
  for (const key of Object.keys(edit)) {
    if (!allowed.includes(key))
      throw new ManifestError(`edit field ${JSON.stringify(key)} not in the mutation surface`);
  }
  switch (kind) {
    case 'edit_role_prompt':
      if (typeof edit['role'] !== 'string' || typeof edit['newPrompt'] !== 'string')
        throw new ManifestError('edit_role_prompt requires role + newPrompt');
      break;
    case 'adjust_tool_allowlist': {
      const add = edit['add']; const remove = edit['remove'];
      if (typeof edit['role'] !== 'string' || !Array.isArray(add) || !Array.isArray(remove))
        throw new ManifestError('adjust_tool_allowlist requires role + add[] + remove[]');
      for (const t of [...add, ...remove] as unknown[])
        if (typeof t !== 'string') throw new ManifestError('allowlist entries must be strings');
      break;
    }
    case 'retarget_model':
      if (typeof edit['role'] !== 'string' || typeof edit['model'] !== 'string' || (edit['model'] as string).length === 0)
        throw new ManifestError('retarget_model requires role + non-empty model');
      break;
    case 'tune_role_budgets':
      for (const k of ['maxToolIterations', 'tokenBudget', 'timeoutMs'] as const) {
        const v = edit[k];
        if (v !== undefined && (typeof v !== 'number' || v <= 0))
          throw new ManifestError(`${k} must be a positive number`);
      }
      break;
    case 'add_processor': {
      const b = edit['bundle'] as Record<string, unknown> | undefined;
      if (!b || typeof b !== 'object' || typeof b['name'] !== 'string')
        throw new ManifestError('add_processor requires bundle.name (static registry reference)');
      break;
    }
    case 'rebind_planner_recall':
      break;
  }
}

/** Apply a manifest edit to a harness, producing a NEW harness (immutable semantics). */
export function applyEdit(current: HarnessConfig, edit: HarnessEdit, candidateId: string): HarnessConfig {
  const roleSet = structuredClone(current.roleSet);
  let bundles = current.processorBundles.map((b) => ({ ...b }));
  let recall = current.plannerRecall ? { ...current.plannerRecall } : undefined;

  const editRole = <T extends HarnessEdit & { role: string }>(e: T, f: (role: HarnessConfig['roleSet']['roles'][number]) => void): void => {
    const target = roleSet.roles.find((r) => r.role === e.role);
    if (!target) throw new ManifestError(`role ${JSON.stringify(e.role)} not in harness`);
    f(target);
  };

  switch (edit.kind) {
    case 'edit_role_prompt':
      editRole(edit, (r) => { r.systemPrompt = edit.newPrompt; delete r.promptFile; });
      break;
    case 'adjust_tool_allowlist':
      editRole(edit, (r) => {
        const set = new Set(r.allowedTools);
        for (const t of edit.remove) set.delete(t);
        for (const t of edit.add) set.add(t);
        r.allowedTools = [...set];
      });
      break;
    case 'retarget_model':
      editRole(edit, (r) => { r.model = edit.model; });
      break;
    case 'tune_role_budgets':
      editRole(edit, (r) => {
        if (edit.maxToolIterations !== undefined) r.maxToolIterations = edit.maxToolIterations;
        if (edit.tokenBudget !== undefined) r.tokenBudget = edit.tokenBudget;
        if (edit.timeoutMs !== undefined) r.timeoutMs = edit.timeoutMs;
      });
      break;
    case 'add_processor':
      bundles = [...bundles, edit.bundle.config !== undefined
        ? { name: edit.bundle.name, config: edit.bundle.config }
        : { name: edit.bundle.name }];
      break;
    case 'rebind_planner_recall':
      recall = {
        ...(recall ?? {}),
        ...(edit.pastFailuresLimit !== undefined ? { pastFailuresLimit: edit.pastFailuresLimit } : {}),
        ...(edit.lcmGrepBudgetTokens !== undefined ? { lcmGrepBudgetTokens: edit.lcmGrepBudgetTokens } : {}),
      };
      break;
  }

  return mintHarnessConfig({
    id: candidateId,
    roleSet,
    processorBundles: bundles,
    ...(recall ? { plannerRecall: recall } : {}),
  });
}
