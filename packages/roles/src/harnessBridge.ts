import type { HarnessRoleConfig, HarnessRoleSet } from '@maf/harness-config';
import { HarnessConfigError } from '@maf/harness-config';
import { makeToolId } from '@maf/types';
import type { RoleConfig, RoleSet } from './RoleConfig.js';

/**
 * Harness → roles boundary (parse at the boundary, §1 of the constitution):
 * harness configs carry structural string data; this function validates and
 * brands it into the roles package's domain types.
 */
export function roleSetFromHarness(roleSet: HarnessRoleSet): RoleSet {
  return {
    version: 1,
    defaultRole: roleSet.defaultRole,
    roles: roleSet.roles.map(roleConfigFromHarness),
  };
}

function roleConfigFromHarness(r: HarnessRoleConfig): RoleConfig {
  if (r.execution !== undefined && r.execution !== 'cli' && r.execution !== 'in-process') {
    throw new HarnessConfigError(
      `role "${r.role}": execution must be 'cli' | 'in-process', got ${JSON.stringify(r.execution)}`,
    );
  }
  if (r.timeoutMs !== undefined && r.timeoutMs <= 0)
    throw new HarnessConfigError(`role "${r.role}": timeoutMs must be positive`);
  if (r.maxToolIterations !== undefined && r.maxToolIterations <= 0)
    throw new HarnessConfigError(`role "${r.role}": maxToolIterations must be positive`);
  return {
    role: r.role,
    allowedTools: r.allowedTools.map(makeToolId),
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
    ...(r.promptFile !== undefined ? { promptFile: r.promptFile } : {}),
    ...(r.policyTag !== undefined ? { policyTag: r.policyTag } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.execution !== undefined ? { execution: r.execution } : {}),
    ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
    ...(r.maxToolIterations !== undefined ? { maxToolIterations: r.maxToolIterations } : {}),
    ...(r.tokenBudget !== undefined ? { tokenBudget: r.tokenBudget } : {}),
  };
}
