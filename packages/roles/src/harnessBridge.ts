import type { HarnessRoleConfig, HarnessRoleSet } from '@maf/harness-config';
import { HarnessConfigError } from '@maf/harness-config';
import { makeToolId } from '@maf/types';
import type { RoleConfig, RoleSet } from './RoleConfig.js';
import { defineRoleName } from './RoleConfig.js';
import { RoleConfigError } from './RoleRegistry.js';
import type { RoleRegistry } from './RoleRegistry.js';

/**
 * Harness → roles boundary (parse at the boundary, §1 of the constitution):
 * harness configs carry structural string data; this function validates and
 * brands it into the roles package's domain types.
 */
export function roleSetFromHarness(roleSet: HarnessRoleSet): RoleSet {
  return {
    version: 1,
    defaultRole: defineRoleName(roleSet.defaultRole),
    roles: roleSet.roles.map(roleConfigFromHarness),
  };
}

/**
 * Roles → harness: the role set a harness hashes. A role that names a prompt file carries the
 * file's text as `systemPrompt` — exactly what `registry.loadPrompt` returns, and what dispatch
 * reads first — so editing a prompt file changes the sha, and a harness dispatches the text it
 * was hashed with whatever the file says later. The path stays, as provenance. Every other field
 * is carried as the registry holds it, so a field added to `RoleConfig` is hashed without an edit
 * here — but `roleConfigFromHarness` (the other direction) copies only the fields it lists, so the
 * field is dispatched only once it is added there too. Edit both directions together; the
 * round-trip test in harness-identity.test.ts holds them to it.
 */
export async function harnessRoleSetFromRegistry(registry: RoleRegistry): Promise<HarnessRoleSet> {
  const roles: HarnessRoleConfig[] = [];
  for (const role of registry.list()) {
    const copy: HarnessRoleConfig = { ...role, allowedTools: [...role.allowedTools] };
    if (role.systemPrompt === undefined && role.promptFile !== undefined) {
      // Read now, not at the role's first dispatch: a prompt the harness cannot hash cannot run.
      copy.systemPrompt = await registry.loadPrompt(role).catch((err: unknown) => {
        throw new RoleConfigError(
          `Role "${role.role}" names prompt file "${role.promptFile}", which could not be read, so no ` +
          `harness can be minted for this role set (${err instanceof Error ? err.message : String(err)})`,
        );
      });
    }
    roles.push(copy);
  }
  return { version: 1, defaultRole: registry.defaultRole, roles };
}

function roleConfigFromHarness(r: HarnessRoleConfig): RoleConfig {
  if (r.execution !== undefined && r.execution !== 'cli' && r.execution !== 'in-process') {
    throw new HarnessConfigError(
      `role "${r.role}": execution must be 'cli' | 'in-process', got ${JSON.stringify(r.execution)}`,
    );
  }
  if (r.expectsChange !== undefined && typeof r.expectsChange !== 'boolean') {
    throw new HarnessConfigError(
      `role "${r.role}": expectsChange must be a boolean, got ${JSON.stringify(r.expectsChange)}`,
    );
  }
  if (r.timeoutMs !== undefined && r.timeoutMs <= 0)
    throw new HarnessConfigError(`role "${r.role}": timeoutMs must be positive`);
  if (r.maxToolIterations !== undefined && r.maxToolIterations <= 0)
    throw new HarnessConfigError(`role "${r.role}": maxToolIterations must be positive`);
  return {
    role: defineRoleName(r.role),
    allowedTools: r.allowedTools.map(makeToolId),
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
    ...(r.promptFile !== undefined ? { promptFile: r.promptFile } : {}),
    ...(r.policyTag !== undefined ? { policyTag: r.policyTag } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.execution !== undefined ? { execution: r.execution } : {}),
    ...(r.expectsChange !== undefined ? { expectsChange: r.expectsChange } : {}),
    ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
    ...(r.maxToolIterations !== undefined ? { maxToolIterations: r.maxToolIterations } : {}),
    ...(r.tokenBudget !== undefined ? { tokenBudget: r.tokenBudget } : {}),
  };
}
