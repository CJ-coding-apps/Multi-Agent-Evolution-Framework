/**
 * HarnessConfig — how agents behave, independent of which adapter executes them.
 * First-class: serializable, comparable, content-hashed, substitutable.
 * Immutable by convention: "changing" a harness means minting a new sha.
 *
 * See HARNESSX_INTEGRATION_PLAN.md §3.
 *
 * NOTE (DAG §10.3): harness-config does NOT import @maf/roles (cycle). Role data
 * is carried structurally; @maf/roles owns validation + branded types via
 * roleSetFromHarness(). Structural assignability holds in both directions for
 * the shared fields.
 */
export interface HarnessRoleConfig {
  role:               string;
  description?:       string;
  systemPrompt?:      string;
  promptFile?:        string;
  allowedTools:       string[];
  policyTag?:         string;
  model?:             string;
  execution?:         'cli' | 'in-process';
  timeoutMs?:         number;
  maxToolIterations?: number;
  tokenBudget?:       number;
}

export interface HarnessRoleSet {
  version:     1;
  defaultRole: string;
  roles:       HarnessRoleConfig[];
}

export interface HarnessConfig {
  version: 1;
  /** Human label, e.g. "legacy-default". Unique within a HarnessStore. */
  id: string;
  /** sha256 of the canonical serialization (excludes this field itself). */
  sha: string;
  /** Role catalog: prompt, tool allowlist, model, budgets per role. */
  roleSet: HarnessRoleSet;
  /** Named references into the static processor registry (empty = CLI-era behavior). */
  processorBundles: ProcessorRef[];
  /** Planner-side knobs worth evolving (Phase 3 mutation surface). */
  plannerRecall?: PlannerRecallConfig;
}

export interface ProcessorRef {
  /** Key into the static ProcessorRegistry — never an arbitrary module path. */
  name: string;
  /** Per-processor config; validated by the processor's own schema at build time. */
  config?: Record<string, unknown>;
}

export interface PlannerRecallConfig {
  pastFailuresLimit?: number;
  lcmGrepBudgetTokens?: number;
}

export class HarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessConfigError';
  }
}

export class HarnessIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessIntegrityError';
  }
}

/** Structural validation — parse, don't validate downstream. Throws HarnessConfigError. */
export function assertHarnessConfig(x: unknown): asserts x is HarnessConfig {
  if (!x || typeof x !== 'object') throw new HarnessConfigError('HarnessConfig must be an object');
  const o = x as Record<string, unknown>;
  if (o['version'] !== 1) throw new HarnessConfigError('HarnessConfig.version must be 1');
  if (typeof o['id'] !== 'string' || o['id'].length === 0)
    throw new HarnessConfigError('HarnessConfig.id must be a non-empty string');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o['id'] as string))
    throw new HarnessConfigError(`HarnessConfig.id ${JSON.stringify(o['id'])} is not a valid slug`);
  if (typeof o['sha'] !== 'string' || !/^[0-9a-f]{64}$/.test(o['sha'] as string))
    throw new HarnessConfigError('HarnessConfig.sha must be a 64-char lowercase hex sha256');
  const roleSet = o['roleSet'] as Record<string, unknown> | undefined;
  if (!roleSet || typeof roleSet !== 'object' || roleSet['version'] !== 1)
    throw new HarnessConfigError('HarnessConfig.roleSet must be a RoleSet v1');
  if (typeof roleSet['defaultRole'] !== 'string' || !Array.isArray(roleSet['roles']))
    throw new HarnessConfigError('HarnessConfig.roleSet requires defaultRole and roles[]');
  for (const r of roleSet['roles'] as unknown[]) {
    const rr = r as Record<string, unknown>;
    if (!rr || typeof rr['role'] !== 'string' || !Array.isArray(rr['allowedTools']))
      throw new HarnessConfigError('HarnessConfig.roleSet.roles entries require role + allowedTools');
  }
  if (!Array.isArray(o['processorBundles']))
    throw new HarnessConfigError('HarnessConfig.processorBundles must be an array');
  for (const p of o['processorBundles'] as unknown[]) {
    const pp = p as Record<string, unknown>;
    if (!pp || typeof pp['name'] !== 'string')
      throw new HarnessConfigError('ProcessorRef entries require a string name');
    if (pp['config'] !== undefined && (typeof pp['config'] !== 'object' || pp['config'] === null))
      throw new HarnessConfigError('ProcessorRef.config must be an object when present');
  }
  if (o['plannerRecall'] !== undefined) {
    const pr = o['plannerRecall'] as Record<string, unknown>;
    if (typeof pr !== 'object' || pr === null)
      throw new HarnessConfigError('plannerRecall must be an object');
    for (const k of ['pastFailuresLimit', 'lcmGrepBudgetTokens'] as const) {
      if (pr[k] !== undefined && (typeof pr[k] !== 'number' || (pr[k] as number) < 0))
        throw new HarnessConfigError(`plannerRecall.${k} must be a non-negative number`);
    }
  }
}
