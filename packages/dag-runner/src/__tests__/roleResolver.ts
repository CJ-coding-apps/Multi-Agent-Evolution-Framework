import type { Result, RoleName, RoleResolver, UnknownRole } from '@maf/types';
import { err, ok } from '@maf/types';

/**
 * A closed role set for tests.
 *
 * dag-runner deliberately does not depend on `@maf/roles`: it is handed a `RoleResolver`, and
 * in production that resolver is the `RoleRegistry`. This stands in for it so the package keeps
 * that independence. It is the only place in this package where a `RoleName` is minted, and it
 * exists only because the tests need a resolver whose answer is fixed and readable.
 */
export function testRoleResolver(names: readonly string[], defaultRole: string): RoleResolver {
  const known = names as readonly RoleName[];
  return {
    defaultRole: defaultRole as RoleName,
    resolveRole(raw: string): Result<RoleName, UnknownRole> {
      return known.includes(raw as RoleName) ? ok(raw as RoleName) : err({ requested: raw, known });
    },
  };
}
