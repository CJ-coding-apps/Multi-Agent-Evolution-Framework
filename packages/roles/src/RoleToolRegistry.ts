import type { ToolId, ToolPlugin } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';

export class RoleToolRegistry {
  private readonly allowed: Set<ToolId>;

  constructor(private readonly base: ToolRegistry, allowed: Iterable<ToolId>) {
    this.allowed = new Set(allowed);
  }

  get(id: ToolId): ToolPlugin | undefined {
    if (!this.allowed.has(id)) return undefined;
    return this.base.get(id);
  }

  getAll(): ToolPlugin[] {
    return this.base.getAll().filter((t) => this.allowed.has(t.id));
  }

  has(id: ToolId): boolean {
    return this.allowed.has(id) && this.base.get(id) !== undefined;
  }

  toJsonSchema(): unknown[] {
    return this.getAll().map((t) => ({
      name:            t.name,
      description:     t.description,
      permissionLevel: t.permissionLevel,
    }));
  }
}
