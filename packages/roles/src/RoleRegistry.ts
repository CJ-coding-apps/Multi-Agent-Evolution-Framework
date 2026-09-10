import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolId } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { RoleConfig, RoleSet, RoleCatalogEntry } from './RoleConfig.js';
import { DEFAULT_ROLE_SET } from './defaults.js';

export class RoleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConfigError';
  }
}

export class RoleRegistry {
  private readonly byName = new Map<string, RoleConfig>();
  private readonly defaultRole: string;
  private readonly mafDir: string;
  private readonly promptCache = new Map<string, string>();

  private constructor(set: RoleSet, mafDir: string) {
    for (const role of set.roles) {
      if (this.byName.has(role.role)) {
        throw new RoleConfigError(`Duplicate role "${role.role}" in role set`);
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

  static async fromYamlOrDefault(
    yamlPath: string,
    mafDir: string,
    baseTools: ToolRegistry,
  ): Promise<RoleRegistry> {
    try {
      const text = await readFile(yamlPath, 'utf8');
      const parsed = parseRoleSet(text);
      validateAllowedTools(parsed, baseTools);
      return new RoleRegistry(parsed, mafDir);
    } catch (err: unknown) {
      if (err instanceof RoleConfigError) throw err;
      // File missing or malformed → fall back to defaults (parity with PolicyEngine.fromYaml)
      return new RoleRegistry(DEFAULT_ROLE_SET, mafDir);
    }
  }

  getRole(name: string): RoleConfig {
    const role = this.byName.get(name);
    if (role) return role;
    const fallback = this.byName.get(this.defaultRole);
    if (!fallback) throw new RoleConfigError(`Default role "${this.defaultRole}" missing`);
    return fallback;
  }

  hasRole(name: string): boolean {
    return this.byName.has(name);
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
    if (role.systemPrompt) return role.systemPrompt;
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

function parseRoleSet(text: string): RoleSet {
  // Mirrors policy-engine's parseSimpleYaml: strip comment lines, JSON.parse the rest.
  // Users authoring .maf/roles.yaml as JSON (the existing pattern for .maf/policy.yaml) works directly.
  const stripped = text.replace(/^\s*#.*$/gm, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new RoleConfigError('roles.yaml could not be parsed as JSON (install a YAML parser for true YAML support)');
  }
  if (!isRoleSet(parsed)) {
    throw new RoleConfigError('roles.yaml does not match the expected RoleSet shape');
  }
  return parsed;
}

function isRoleSet(x: unknown): x is RoleSet {
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
