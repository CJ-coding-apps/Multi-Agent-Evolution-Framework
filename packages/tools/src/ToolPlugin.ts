import type {
  ToolId, ToolInput, ToolResult, ToolContext, ToolPlugin, PermissionLevel,
} from '@maf/types';

export abstract class BaseTool<I extends ToolInput = ToolInput> implements ToolPlugin<I> {
  abstract readonly id: ToolId;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly permissionLevel: PermissionLevel;
  abstract execute(input: I, ctx: ToolContext): Promise<ToolResult>;

  protected ok(stdout: string, duration: number, metadata: Record<string, unknown> = {}): ToolResult {
    return { stdout, stderr: '', exitCode: 0, duration, metadata };
  }

  protected err(stderr: string, duration: number, exitCode = 1): ToolResult {
    return { stdout: '', stderr, exitCode, duration, metadata: {} };
  }
}

export class ToolRegistry {
  private tools = new Map<ToolId, ToolPlugin>();

  register(tool: ToolPlugin): void {
    this.tools.set(tool.id, tool);
  }

  get(id: ToolId): ToolPlugin | undefined {
    return this.tools.get(id);
  }

  getAll(): ToolPlugin[] {
    return [...this.tools.values()];
  }

  toJsonSchema(): unknown[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      permissionLevel: t.permissionLevel,
    }));
  }
}
