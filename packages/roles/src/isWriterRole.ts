import type { ToolId } from '@maf/types';

/**
 * The tools that change the working tree or the repository's history: every tool the default
 * registry rates `write` or `dangerous`. A new tool of either kind belongs here too.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'fs.write', 'fs.delete', 'patch.apply', 'git.commit', 'git.reset', 'git.add',
]);

/**
 * Whether a role can change the code, and so must have its diff security-reviewed.
 *
 * Decided by the tools the role holds, never by its name (D-07). Keying on `role === 'coder'`
 * left a tester holding `patch.apply`, or any custom writer role, unreviewed.
 */
export function isWriterRole(role: { readonly allowedTools: readonly ToolId[] }): boolean {
  return role.allowedTools.some((id) => WRITE_TOOLS.has(id));
}
