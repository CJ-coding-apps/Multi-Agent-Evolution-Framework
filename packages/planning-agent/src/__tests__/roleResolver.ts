import type { Result, RoleName, RoleResolver, UnknownRole } from '@maf/types';
import { err, ok } from '@maf/types';

/**
 * A closed role set for tests.
 *
 * planning-agent deliberately does not depend on `@maf/roles`: it is handed a `RoleResolver`,
 * and in production that resolver is the `RoleRegistry`. This stands in for it so the package
 * keeps that independence, and the default role is always `coder`.
 */
export function rolesOf(names: readonly string[]): RoleResolver {
  const known = names as readonly RoleName[];
  return {
    defaultRole: 'coder' as RoleName,
    resolveRole(raw: string): Result<RoleName, UnknownRole> {
      return known.includes(raw as RoleName) ? ok(raw as RoleName) : err({ requested: raw, known });
    },
  };
}
