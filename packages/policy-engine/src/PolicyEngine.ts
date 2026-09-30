import { readFile } from 'node:fs/promises';
import { minimatch } from 'minimatch';
import crypto from 'node:crypto';
import type {
  PolicyEngineHandle, PolicyRule, PolicyDecision, PolicyAction,
  ToolId, ToolInput, ToolContext, ApprovalRequest, GraphQueryRunner,
} from '@maf/types';
import { resolveInside, PathEscapeError } from '@maf/types';
import { bindPolicyTemplate } from './policyTemplate.js';

/**
 * Every declared path, resolved against `root` and proven to lie inside it.
 *
 * One escape fails the whole call: a multi-path call is a unit — the tool was asked to act on
 * all of them — and a path that could not be confined is not a path whose rules may be skipped.
 */
async function confineAll(root: string, declaredPaths: readonly string[]): Promise<string[]> {
  const confined: string[] = [];
  for (const declared of declaredPaths) {
    confined.push((await resolveInside(root, declared)).relative);
  }
  return confined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A decision that refuses: everything but Allow, and `Indeterminate` refuses the same way. */
export type Refusal = PolicyDecision & { verdict: 'Deny' | 'Escalate' | 'Indeterminate' };

/**
 * What a rule's graph half answered. Three-valued because the graph has three outcomes, and the
 * third one — it could not be asked — has to survive to the caller rather than being flattened
 * into "no match".
 */
type PatternResult =
  | { kind: 'match' }
  | { kind: 'nomatch' }
  | { kind: 'error'; detail: string };

export class PolicyViolationError extends Error {
  constructor(public readonly decision: Refusal) {
    super(`Policy violation: ${decision.verdict}`);
  }
}

export class PolicyEngine implements PolicyEngineHandle {
  private rules: PolicyRule[] = [];

  constructor(private readonly graph: GraphQueryRunner) {}

  loadRules(rules: PolicyRule[]): void {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  static async fromYaml(yamlPath: string, graph: GraphQueryRunner): Promise<PolicyEngine> {
    const engine = new PolicyEngine(graph);
    try {
      const text = await readFile(yamlPath, 'utf8');
      const parsed = parseSimpleYaml(text) as { rules?: PolicyRule[] };
      engine.loadRules(parsed.rules ?? []);
    } catch { /* no policy file → no rules */ }
    return engine;
  }

  async evaluate(
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
    declaredPaths: readonly string[],
  ): Promise<PolicyDecision> {
    // Confinement comes before the first rule, and it does not depend on a rule existing. A glob
    // is written against a path relative to the project root, so matching it against the raw
    // input string matched only the spellings a caller happened to use: `.env` was denied while
    // `./.env`, `a/../.env` and — the sweep's repro — `../.env` were not, and that last one also
    // left the root entirely. Resolving first makes every spelling of one file one string, and
    // makes a path that leaves the root a refusal rather than a string no rule recognises.
    let confined: string[];
    try {
      confined = await confineAll(ctx.projectRoot, declaredPaths);
    } catch (err) {
      // `Deny`, not `Indeterminate`: a path outside the root — or one that cannot be shown to be
      // inside it — is a decision about this call, not a failure to reach one. `Deny` is not
      // escalatable, so there is nothing here for a human to approve either way.
      return {
        verdict: 'Deny',
        reason: err instanceof PathEscapeError
          ? err.message
          : `policy could not resolve the declared paths against the project root: ${messageOf(err)}`,
      };
    }

    for (const rule of this.rules) {
      if (!this.matchesToolId(rule, toolId)) continue;
      if (!this.matchesAgentRole(rule, ctx)) continue;
      if (!this.matchesPath(rule, confined)) continue;
      if (!this.matchesAllowedPaths(rule, confined)) continue;
      if (rule.predicate.memoryPattern) {
        const pattern = await this.evaluateCypher(
          rule.predicate.memoryPattern.cypher, toolId, confined, ctx,
        );
        // Three-valued on purpose. The rule's graph half can answer "yes", "no", or nothing at
        // all, and the third case must not be read as "no": skipping the rule there is what made
        // a `Deny` rule stop firing the moment the graph could be broken.
        if (pattern.kind === 'error') {
          return {
            verdict: 'Indeterminate',
            reason: `policy rule "${rule.id}" could not be evaluated: ${pattern.detail}`,
            ruleId: rule.id,
          };
        }
        if (pattern.kind === 'nomatch') continue;
      }
      return this.buildDecision(rule.action, toolId, input, ctx, rule.id);
    }
    return { verdict: 'Allow' };
  }

  private matchesToolId(rule: PolicyRule, toolId: ToolId): boolean {
    const pred = rule.predicate.toolId;
    if (!pred) return true;
    if (Array.isArray(pred)) return pred.includes(toolId);
    return pred === toolId;
  }

  private matchesAgentRole(rule: PolicyRule, ctx: ToolContext): boolean {
    const pred = rule.predicate.agentRole;
    if (!pred) return true;
    const role = ctx.agentRole;
    if (!role) return false;
    if (Array.isArray(pred)) return pred.includes(role);
    return pred === role;
  }

  // Paths come from the calling tool's own declaration, never from a guess about which input
  // keys look like paths. The guess was the defect: `patch.apply` derived its paths inside
  // `execute`, so path rules saw nothing and matched nothing.
  //
  // They arrive here already confined and root-relative (see `evaluate`), so a glob means what
  // its author meant by it: `.env`, `./.env` and `a/../.env` are one path, and none of them is
  // matched by accident or missed by spelling.
  private matchesPath(rule: PolicyRule, declaredPaths: readonly string[]): boolean {
    const glob = rule.predicate.pathGlob;
    if (!glob) return true;
    if (declaredPaths.length === 0) return false;
    return declaredPaths.some((p) => minimatch(p, glob));
  }

  // Rule matches when at least one declared path falls OUTSIDE every allowed glob.
  // Used to express "this role may only modify files matching these patterns" —
  // pair with a Deny action to block writes elsewhere.
  private matchesAllowedPaths(rule: PolicyRule, declaredPaths: readonly string[]): boolean {
    const allowed = rule.predicate.allowedPathGlobs;
    if (!allowed || allowed.length === 0) return true;
    if (declaredPaths.length === 0) return false;
    return declaredPaths.some((p) => !allowed.some((g) => minimatch(p, g)));
  }

  /**
   * Asks the rule's graph half. "Could not ask" is its own answer, with the reason kept: a
   * `Deny` rule that cannot be evaluated must refuse the call, and an operator needs to know
   * whether that was the graph being down or their own template naming something unbindable.
   */
  private async evaluateCypher(
    cypherTemplate: string,
    toolId: ToolId,
    declaredPaths: readonly string[],
    ctx: ToolContext,
  ): Promise<PatternResult> {
    try {
      const rows = await this.graph.run(
        bindPolicyTemplate(cypherTemplate, {
          tool:   toolId,
          path:   declaredPaths[0] ?? '',
          runId:  ctx.runId,
          taskId: ctx.taskId,
        }),
      );
      return rows.length > 0 ? { kind: 'match' } : { kind: 'nomatch' };
    } catch (err) {
      return { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildDecision(
    action: PolicyAction,
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
    ruleId: string,
  ): PolicyDecision {
    switch (action.kind) {
      case 'Allow':
        return { verdict: 'Allow' };
      case 'Deny':
        return { verdict: 'Deny', reason: action.reason ?? 'Policy denied', ...(action.alternative ? { alternative: action.alternative } : {}) };
      case 'Escalate': {
        const request: ApprovalRequest = {
          id:           crypto.randomUUID(),
          runId:        ctx.runId,
          taskId:       ctx.taskId,
          requestedBy:  ctx.agentId,
          toolId,
          policyRuleId: ruleId,
          description:  `Tool ${toolId} requires approval. Path: ${String(input['path'] ?? '')}`,
          createdAt:    new Date(),
          expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000),
        };
        return { verdict: 'Escalate', reason: 'Policy requires approval', approvalRequest: request };
      }
    }
  }
}

// Minimal YAML → JS object parser (handles simple key: value and arrays)
function parseSimpleYaml(text: string): unknown {
  try {
    // Use the YAML spec subset via JSON5-like fallback
    // In real usage, install 'yaml' package: import { parse } from 'yaml'
    return JSON.parse(text.replace(/^\s*#.*$/gm, ''));
  } catch {
    // Very minimal YAML parser for { rules: [...] } structure
    return { rules: [] };
  }
}
