import type { CliAdapter, ToolId } from '@maf/types';
import { isTurnAdapter } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { RoleConfig } from './RoleConfig.js';

/**
 * The tools that can change the working tree or the repository's history: every tool the default
 * registry rates `write`, `dangerous` or `execute`. `test.run` is here because it runs the project's
 * own code, which can write anything. A new tool of any of these kinds belongs here too.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'fs.write', 'fs.delete', 'patch.apply', 'git.commit', 'git.reset', 'git.add', 'test.run',
]);

/**
 * Whether a role can change the code, and so must have its diff security-reviewed.
 *
 * Decided by the tools the role holds, never by its name (D-07). Keying on `role === 'coder'`
 * left a tester holding `patch.apply`, or any custom writer role, unreviewed. The in-process
 * `security-gate` processor reviews exactly these roles too: the dispatcher hands it a runner only
 * for a role this answers true for.
 */
export function isWriterRole(role: { readonly allowedTools: readonly ToolId[] }): boolean {
  return role.allowedTools.some((id) => WRITE_TOOLS.has(id));
}

type TierFields = Pick<RoleConfig, 'allowedTools' | 'execution'>;

/**
 * The tier the role asks for: its `execution`, else in-process for a writer and cli for a reader
 * (D-01). Every guarantee MAF makes — policy verdicts, redaction, attested tool calls, processor
 * hooks — exists only in-process, so a role that can write gets it unless it opts out.
 */
export function requestedTier(role: TierFields): 'cli' | 'in-process' {
  return role.execution ?? (isWriterRole(role) ? 'in-process' : 'cli');
}

/**
 * The tier the role runs on with this adapter, if it runs at all. In-process needs BOTH a
 * `sendTurn` and the `inProcessLoop` capability: an adapter may ship `sendTurn` with the
 * capability off (Codex, whose autonomous mode would run tools past the gate), and it stays on
 * the cli tier. A writer that lands on 'cli' here is refused by the dispatcher unless the run
 * allows ungoverned writers.
 */
export function effectiveTier(role: TierFields, adapter: CliAdapter): 'cli' | 'in-process' {
  const canInProcess = isTurnAdapter(adapter) && adapter.capabilities().inProcessLoop;
  return requestedTier(role) === 'in-process' && canInProcess ? 'in-process' : 'cli';
}

/**
 * Whether the scheduler must serialize this role against every other writer.
 *
 * Decided on the tier the role will actually run on, not the one it asks for: a cli-tier
 * backend has file tools of its own whatever the allowlist says, so every role that runs there
 * holds the lock — including a read-only role that asked for in-process on an adapter that
 * cannot provide it. In-process, every call goes through the registry and the policy gate, so a
 * role whose every tool is read-level cannot write; a tool the registry cannot resolve is not
 * assumed harmless.
 */
export function isWriterForLock(role: TierFields, adapter: CliAdapter, baseTools: ToolRegistry): boolean {
  if (effectiveTier(role, adapter) === 'cli') return true;
  return role.allowedTools.some((id) => {
    const tool = baseTools.get(id);
    return tool === undefined || tool.permissionLevel !== 'read';
  });
}
