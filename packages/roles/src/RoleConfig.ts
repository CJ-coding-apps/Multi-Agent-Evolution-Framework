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

/**
 * The number of tool-calling turns the in-process loop allows when a role names no
 * `maxToolIterations` of its own: what `RoleDispatcher` passes as `maxTurns`. Named here rather than
 * written as a literal at the one call site, so a built-in reader's cap can be checked against it —
 * a reader whose cap sits *below* this cannot take the `git.diff → fs.read → grep → git.log → answer`
 * chain a review or an audit actually needs, and would fail `budget_exhausted` on a legitimate task.
 */
export const DEFAULT_MAX_TOOL_ITERATIONS = 10;

export interface RoleConfig {
  role:               RoleName;
  description?:       string;
  systemPrompt?:      string;
  promptFile?:        string;
  allowedTools:       ToolId[];
  policyTag?:         string;
  model?:             string;
  /**
   * 'in-process' routes this role through the gated processor-pipeline loop instead of a single
   * opaque CLI invocation. Default: 'in-process' for a role that holds a write tool, 'cli' for
   * one that does not (D-01) — see `effectiveTier`. A writer on the 'cli' tier, by this field or
   * because the adapter cannot run the loop, runs only when the dispatcher allows ungoverned runs.
   */
  execution?:         'cli' | 'in-process';
  /**
   * The role is expected to change the tree (D-32): a 'cli'-tier node whose backend answers and
   * exits 0 but leaves no diff against the start commit fails with `NodeFailure('no_change')`.
   * Only a role that holds a write tool may set it — the registry refuses it on any other.
   */
  expectsChange?:     boolean;
  /**
   * Whether the role is expected to make a tool call (D-46): an in-process role that does not
   * expect a change (`expectsChange` is not true) — the built-in readers and the `tester` — that
   * answers having made zero *executed* tool calls fails with `no_work`. Default `true` for such a
   * role that holds at least one tool, and `false` for a role whose `allowedTools` is empty — it
   * has nothing to call and answers from the prompt by design. A role that expects a change is
   * untouched (`no_change` judges it, D-32).
   */
  expectsToolCalls?:  boolean;
  timeoutMs?:         number;
  maxToolIterations?: number;
  tokenBudget?:       number;
}

export interface RoleSet {
  version:     1;
  defaultRole: RoleName;
  roles:       RoleConfig[];
}

/**
 * One role, as a planner reads it (D-43). `writes` and `expectsChange` are the two facts the
 * planner's role block renders — "read-only", "may change the tree", "must change the tree" — so a
 * plan can route a question to a read-only role and a change to one that owes it. Both are derived
 * from the role's *tools*, never its name (D-07): `writes` is `isWriterRole`, `expectsChange` is the
 * role's own declaration, which the registry permits on a writer only.
 */
export interface RoleCatalogEntry {
  role:          RoleName;
  description:   string;
  /** True when the role holds a write tool (`isWriterRole`). */
  writes:        boolean;
  /** True when the role is expected to change the tree (D-32), which requires a write tool. */
  expectsChange: boolean;
}
