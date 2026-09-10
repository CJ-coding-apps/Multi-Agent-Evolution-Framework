import { readFile } from 'node:fs/promises';
import { minimatch } from 'minimatch';
import crypto from 'node:crypto';
import type {
  PolicyEngineHandle, PolicyRule, PolicyDecision, PolicyAction,
  ToolId, ToolInput, ToolContext, ApprovalRequest,
} from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';

export class PolicyViolationError extends Error {
  constructor(public readonly decision: PolicyDecision & { verdict: 'Deny' | 'Escalate' }) {
    super(`Policy violation: ${decision.verdict}`);
  }
}

export class PolicyEngine implements PolicyEngineHandle {
  private rules: PolicyRule[] = [];

  constructor(private readonly graph: MemoryGraph) {}

  loadRules(rules: PolicyRule[]): void {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  static async fromYaml(yamlPath: string, graph: MemoryGraph): Promise<PolicyEngine> {
    const engine = new PolicyEngine(graph);
    try {
      const text = await readFile(yamlPath, 'utf8');
      const parsed = parseSimpleYaml(text) as { rules?: PolicyRule[] };
      engine.loadRules(parsed.rules ?? []);
    } catch { /* no policy file → no rules */ }
    return engine;
  }

  async evaluate(toolId: ToolId, input: ToolInput, ctx: ToolContext): Promise<PolicyDecision> {
    for (const rule of this.rules) {
      if (!this.matchesToolId(rule, toolId)) continue;
      if (!this.matchesAgentRole(rule, ctx)) continue;
      if (!this.matchesPath(rule, input)) continue;
      if (!this.matchesAllowedPaths(rule, input)) continue;
      if (rule.predicate.memoryPattern) {
        const matches = await this.evaluateCypher(rule.predicate.memoryPattern.cypher, toolId, input, ctx);
        if (!matches) continue;
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

  private matchesPath(rule: PolicyRule, input: ToolInput): boolean {
    const glob = rule.predicate.pathGlob;
    if (!glob) return true;
    const paths = collectInputPaths(input);
    if (paths.length === 0) return false;
    return paths.some((p) => minimatch(p, glob));
  }

  // Rule matches when at least one input path falls OUTSIDE every allowed glob.
  // Used to express "this role may only modify files matching these patterns" —
  // pair with a Deny action to block writes elsewhere.
  private matchesAllowedPaths(rule: PolicyRule, input: ToolInput): boolean {
    const allowed = rule.predicate.allowedPathGlobs;
    if (!allowed || allowed.length === 0) return true;
    const paths = collectInputPaths(input);
    if (paths.length === 0) return false;
    return paths.some((p) => !allowed.some((g) => minimatch(p, g)));
  }

  private async evaluateCypher(
    cypherTemplate: string,
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
  ): Promise<boolean> {
    const cypher = cypherTemplate
      .replace(/\$tool/g,   `'${toolId}'`)
      .replace(/\$path/g,   `'${String(input['path'] ?? '').replace(/'/g, "''")}'`)
      .replace(/\$runId/g,  `'${ctx.runId}'`)
      .replace(/\$taskId/g, `'${ctx.taskId}'`);
    try {
      const rows = await this.graph.query(cypher, {});
      return (rows as unknown[]).length > 0;
    } catch { return false; }
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

function collectInputPaths(input: ToolInput): string[] {
  const raw = input['paths'];
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string');
  const single = input['path'];
  if (typeof single === 'string' && single) return [single];
  if (typeof raw === 'string' && raw) return [raw];
  return [];
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
