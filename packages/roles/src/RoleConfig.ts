import type { RoleName, ToolId } from '@maf/types';

/**
 * Mint a `RoleName` for a role-set *definition*.
 *
 * The three authors of a role set all go through here and nothing else does: `DEFAULT_ROLE_SET`
 * (the built-in set), `parseRoleSet` (a user's roles.yaml, validated structurally by `isRoleSet`),
 * and `roleSetFromHarness` (a harness's carried set). A name becomes a `RoleName` because a set
 * defined it, and the registry is what holds the set — a set that is malformed in some *other*
 * way (a duplicate name, a default that does not exist) is still caught, by `RoleRegistry`'s
 * constructor, for file-supplied and built-in sets alike.
 *
 * A caller who wants a `RoleName` for a name their set did not define calls
 * `RoleRegistry.resolveRole`, which answers against the set in force. `packages/roles`'
 * `role-name-mint` test fails if either half of this rule is broken.
 */
export function defineRoleName(name: string): RoleName { return name as RoleName; }

export interface RoleConfig {
  role:               RoleName;
  description?:       string;
  systemPrompt?:      string;
  promptFile?:        string;
  allowedTools:       ToolId[];
  policyTag?:         string;
  model?:             string;
  /** 'in-process' routes this role through the gated processor-pipeline loop
   *  instead of a single opaque CLI invocation. Default: 'cli'. */
  execution?:         'cli' | 'in-process';
  timeoutMs?:         number;
  maxToolIterations?: number;
  tokenBudget?:       number;
}

export interface RoleSet {
  version:     1;
  defaultRole: RoleName;
  roles:       RoleConfig[];
}

export interface RoleCatalogEntry {
  role:        RoleName;
  description: string;
}
