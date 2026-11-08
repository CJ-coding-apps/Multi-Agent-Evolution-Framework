import type { RoleName } from '@maf/types';
import type { RoleConfig, RoleSet, RoleCatalogEntry } from './RoleConfig.js';
import { isWriterRole } from './isWriterRole.js';
import { DEFAULT_ROLE_SET_FROM_SHIPPED } from './defaultRoleSet.generated.js';

/**
 * The built-in role set: the shipped `.maf/roles.yaml` and its prompt files, compiled in (D-61).
 *
 * A plain run uses this set only when the target has no roles file (D-08); `maf init` writes the
 * same role set as files. The two are one source: `scripts/generate-default-roles.mjs` generates
 * `defaultRoleSet.generated.ts` from `.maf/roles.yaml` and `.maf/prompts/*.md`, and
 * `defaults.test.ts` fails when the generated set and the files disagree. Before D-61 the set was
 * maintained by hand beside the files and had drifted — the prompts differed, and the built-in
 * `tester` held no `fs.write` while the shipped one did (F2).
 *
 * The generated data carries what the file declares: the prompt's text (not a path, which a target
 * without `.maf/prompts/` could not read), `policyTag`, `execution`, `expectsChange`,
 * `expectsToolCalls`, limits and the allowed tools. The shipped `tester` holds `fs.write` and so is
 * a writer, `coder` is the only role that expects a change (D-32), and the three readers run
 * in-process (D-44) — all of it declared in the file, not here.
 */
export const DEFAULT_ROLE_SET: RoleSet = DEFAULT_ROLE_SET_FROM_SHIPPED;

export const DEFAULT_ROLE_CATALOG: RoleCatalogEntry[] = DEFAULT_ROLE_SET.roles.map((r) => ({
  role:          r.role,
  description:   r.description ?? '',
  writes:        isWriterRole(r),
  expectsChange: r.expectsChange === true,
}));

export function getDefaultRoleConfig(role: RoleName): RoleConfig | undefined {
  return DEFAULT_ROLE_SET.roles.find((r) => r.role === role);
}
