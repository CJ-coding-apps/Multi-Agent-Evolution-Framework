import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseYamlDocument, YamlSyntaxError } from '@maf/policy-engine';
import type { Result, RoleName, RoleResolver, UnknownRole } from '@maf/types';
import { err, ok } from '@maf/types';
import type { ToolId } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { RoleConfig, RoleSet, RoleCatalogEntry } from './RoleConfig.js';
import { defineRoleName } from './RoleConfig.js';
import { DEFAULT_ROLE_SET } from './defaults.js';
import { isWriterRole } from './isWriterRole.js';

export class RoleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConfigError';
  }
}

/** A role name that the set in force defines, together with its configuration. */
export interface ResolvedRole {
  readonly name:   RoleName;
  readonly config: RoleConfig;
}

export class RoleRegistry implements RoleResolver {
  private readonly byName = new Map<string, RoleConfig>();
  /** The name a node without one gets. Always in `byName` — the constructor proves it. */
  readonly defaultRole: RoleName;
  private readonly mafDir: string;
  private readonly promptCache = new Map<string, string>();

  private constructor(set: RoleSet, mafDir: string) {
    for (const role of set.roles) {
      if (this.byName.has(role.role)) {
        throw new RoleConfigError(`Duplicate role "${role.role}" in role set`);
      }
      // A role with no write tool could change the tree only through a cli-tier backend's own
      // tools, outside every gate — so it may not be told that changing the tree is its job.
      if (role.expectsChange === true && !isWriterRole(role)) {
        throw new RoleConfigError(
          `Role "${role.role}" sets expectsChange: true, which needs a role that holds a write tool ` +
          '(fs.write, fs.delete, patch.apply, git.add, git.commit, git.reset or test.run), but it holds none.',
        );
      }
      this.byName.set(role.role, role);
    }
    if (!this.byName.has(set.defaultRole)) {
      throw new RoleConfigError(`defaultRole "${set.defaultRole}" not found in roles`);
    }
    this.defaultRole = set.defaultRole;
    this.mafDir = mafDir;
  }

  static fromSet(set: RoleSet, mafDir: string, baseTools?: ToolRegistry): RoleRegistry {
    if (baseTools) validateAllowedTools(set, baseTools);
    return new RoleRegistry(set, mafDir);
  }

  /**
   * The role set in the file at `yamlPath`, or the built-in set when there is no file there (D-08).
   *
   * Only absence means "the built-in roles". Every other failure throws: a file that cannot be
   * read, is not YAML, or fails validation was meant to say something, and the built-in set it
   * would be replaced with includes `coder`, a writer.
   */
  static async fromYamlOrDefault(
    yamlPath: string,
    mafDir: string,
    baseTools: ToolRegistry,
  ): Promise<RoleRegistry> {
    let text: string;
    try {
      text = await readFile(yamlPath, 'utf8');
    } catch (err: unknown) {
      // A dangling symlink also reads as ENOENT, but its name exists: the role set it pointed at
      // has gone, which is not the same as there being none.
      if (isNotFound(err) && !(await nameExists(yamlPath))) {
        return new RoleRegistry(DEFAULT_ROLE_SET, mafDir);
      }
      throw new RoleConfigError(
        `Roles file ${JSON.stringify(yamlPath)} exists but could not be read, and a roles file that ` +
        `exists is never replaced by the built-in roles: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = parseRoleSet(text, yamlPath);
    validateAllowedTools(parsed, baseTools);
    return new RoleRegistry(parsed, mafDir);
  }

  /**
   * Look a name up against the set in force.
   *
   * This is the replacement for a `getRole` that returned the **default** role — `coder`,
   * with `fs.write`, `fs.delete`, `git.commit`, `git.reset` and `patch.apply` — for any
   * name it did not recognise. A hallucinated role name therefore *widened* privilege
   * instead of being refused, and the planner's "warn and carry on" path was the privilege
   * path. There is no fallback here at all: the caller decides, and the caller has the
   * context to decide well.
   */
  resolve(raw: string): Result<ResolvedRole, UnknownRole> {
    const config = this.byName.get(raw);
    if (!config) return err({ requested: raw, known: this.names() });
    return ok({ name: config.role, config });
  }

  /** The {@link RoleResolver} half: just the name, for a node that records one. */
  resolveRole(raw: string): Result<RoleName, UnknownRole> {
    const resolved = this.resolve(raw);
    return resolved.ok ? ok(resolved.value.name) : resolved;
  }

  /**
   * The configuration for a `RoleName` this registry minted.
   *
   * A miss is a programming error, not bad data: it means the name came from a different
   * registry. That is why it throws rather than falling back — there is no role to fall
   * back *to* that would be the caller's intent.
   */
  getRole(name: RoleName): RoleConfig {
    const role = this.byName.get(name);
    if (!role) throw new RoleConfigError(`Role "${name}" is not defined by this role set`);
    return role;
  }

  hasRole(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every name the set defines, in declaration order. */
  names(): RoleName[] {
    return this.list().map((r) => r.role);
  }

  /**
   * Whether dispatching `roleName` can change the shared working tree, i.e. whether the
   * scheduler has to serialize it against every other writer.
   *
   * Every CLI-tier role is a writer: the CLI agent has its own file tools whatever the
   * allowlist says (the same insight as the CLI-tier MCP rule), so a read-only allowlist
   * proves nothing there. An in-process role is different — every tool call goes through
   * the policy gate and the registry — so a role whose every allowed tool is read-level
   * genuinely cannot write, and two of them can safely run at once.
   *
   * A name this registry did not mint can no longer reach here — `roleName` is a `RoleName`,
   * which means some role set defined it — but the `!role` branch stays anyway, and it answers
   * `true`. If the invariant ever breaks, it breaks toward serializing a reader, never toward
   * letting two writers run at once.
   */
  writesToWorkingTree(roleName: RoleName, tools: ToolRegistry): boolean {
    const role = this.byName.get(roleName);
    if (!role) return true;
    if ((role.execution ?? 'cli') !== 'in-process') return true;
    return role.allowedTools.some((id) => {
      const tool = tools.get(id as ToolId);
      return tool === undefined || tool.permissionLevel !== 'read';
    });
  }

  getDefault(): RoleConfig {
    const role = this.byName.get(this.defaultRole);
    if (!role) throw new RoleConfigError(`Default role "${this.defaultRole}" missing`);
    return role;
  }

  list(): RoleConfig[] {
    return [...this.byName.values()];
  }

  catalog(): RoleCatalogEntry[] {
    return this.list().map((r) => ({ role: r.role, description: r.description ?? '' }));
  }

  async loadPrompt(role: RoleConfig): Promise<string> {
    // `!== undefined`, not truthiness: a harness inlines an empty prompt file as '' beside its
    // path, and re-reading the file would dispatch text the harness sha does not cover.
    if (role.systemPrompt !== undefined) return role.systemPrompt;
    if (!role.promptFile) {
      throw new RoleConfigError(`Role "${role.role}" has neither systemPrompt nor promptFile`);
    }
    const cached = this.promptCache.get(role.role);
    if (cached !== undefined) return cached;
    const filePath = path.isAbsolute(role.promptFile)
      ? role.promptFile
      : path.join(this.mafDir, role.promptFile);
    const content = await readFile(filePath, 'utf8');
    this.promptCache.set(role.role, content);
    return content;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

async function nameExists(p: string): Promise<boolean> {
  return lstat(p).then(() => true, () => false);
}

function parseRoleSet(text: string, source: string): RoleSet {
  // YAML, through the parser policy files use (D-08). The JSON-with-`#`-comment-lines form roles
  // files have always been written in is YAML too, so every file that loaded before still does —
  // except one that repeats a key in a mapping, which JSON.parse resolved by keeping the last.
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(text, source).value;
  } catch (err: unknown) {
    if (!(err instanceof YamlSyntaxError)) throw err;
    throw new RoleConfigError(
      `Roles file ${JSON.stringify(source)} is not valid YAML at line ${err.line}, column ${err.column}, ` +
      `so the run cannot start: ${err.reason}`,
    );
  }
  if (!isRoleSet(parsed)) {
    throw new RoleConfigError(
      `Roles file ${JSON.stringify(source)} does not match the role-set shape: expected version: 1, ` +
      'a defaultRole, and a roles list whose entries each have a role name and an allowedTools list.',
    );
  }
  // An empty inline prompt is the prompt (`loadPrompt` checks `!== undefined`, so a harness can
  // carry an empty prompt file's text). Written by hand in a roles file, it would dispatch "" and
  // hide any promptFile beside it, so it is refused here rather than run.
  for (const r of parsed.roles) {
    if (r.systemPrompt === '')
      throw new RoleConfigError(
        `Role "${r.role}" has an empty systemPrompt; give it text or a promptFile` +
        (r.promptFile !== undefined ? ` (remove the empty systemPrompt to use promptFile "${r.promptFile}")` : ''),
      );
  }
  // `isRoleSet` checked that every name is a string; this is where those strings become
  // `RoleName`s. A role set is the *definition* of which names exist, so a file that
  // supplies one is authoring the namespace — the same mint the built-in
  // `DEFAULT_ROLE_SET` uses. What is branded here is only the name; whether the set is
  // *usable* (unique names, a default that exists, tools that exist) is the constructor's
  // check, in one place, for built-in and file-supplied sets alike.
  return {
    version:     1,
    defaultRole: defineRoleName(parsed.defaultRole),
    roles:       parsed.roles.map((r) => ({ ...r, role: defineRoleName(r.role) })),
  };
}

/** The shape check for a roles.yaml: every field a `RoleConfig` needs, or nothing. */
interface RawRoleSet {
  version:     1;
  defaultRole: string;
  roles:       Array<Omit<RoleConfig, 'role'> & { role: string }>;
}

function isRoleSet(x: unknown): x is RawRoleSet {
  if (!x || typeof x !== 'object') return false;
  const o = x as { version?: unknown; defaultRole?: unknown; roles?: unknown };
  if (o.version !== 1) return false;
  if (typeof o.defaultRole !== 'string') return false;
  if (!Array.isArray(o.roles)) return false;
  for (const r of o.roles) {
    if (!r || typeof r !== 'object') return false;
    const rr = r as Record<string, unknown>;
    if (typeof rr['role'] !== 'string') return false;
    if (!Array.isArray(rr['allowedTools'])) return false;
    if (rr['systemPrompt'] !== undefined && typeof rr['systemPrompt'] !== 'string') return false;
    if (rr['promptFile']   !== undefined && typeof rr['promptFile']   !== 'string') return false;
    if (rr['expectsChange'] !== undefined && typeof rr['expectsChange'] !== 'boolean') return false;
    // Thrown, not `false`, so the message can name the value: a misspelt tier would otherwise
    // reach the dispatcher and be refused as an adapter that "cannot run the in-process loop".
    const execution = rr['execution'];
    if (execution !== undefined && execution !== 'cli' && execution !== 'in-process') {
      throw new RoleConfigError(
        `Role "${rr['role']}" sets execution ${JSON.stringify(execution)}, but execution must be ` +
        `'cli' or 'in-process'.`,
      );
    }
  }
  return true;
}

function validateAllowedTools(set: RoleSet, baseTools: ToolRegistry): void {
  const known = new Set(baseTools.getAll().map((t) => t.id));
  for (const role of set.roles) {
    for (const id of role.allowedTools) {
      if (!known.has(id as ToolId)) {
        throw new RoleConfigError(`Role "${role.role}" allows unknown tool "${id}"`);
      }
    }
  }
}
