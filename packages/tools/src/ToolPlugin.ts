import { performance } from 'node:perf_hooks';
import type {
  ToolId, ToolInput, ToolInputSchema, ToolResult, ToolContext, ToolPlugin, PermissionLevel,
} from '@maf/types';
import { toolInputProblem } from '@maf/types';

/** A closed input: these fields, `required` among them, and no others. Every built-in tool's shape. */
export function closedInput(properties: ToolInputSchema['properties'], required: readonly string[] = []): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export abstract class BaseTool<I extends ToolInput = ToolInput> implements ToolPlugin<I> {
  abstract readonly id: ToolId;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly permissionLevel: PermissionLevel;
  abstract execute(input: I, ctx: ToolContext): Promise<ToolResult>;

  /**
   * Abstract on purpose: a tool must state its filesystem surface rather than inherit an
   * empty one. A default of `[]` would look identical to `git.status` and would silently
   * exempt the next tool that forgets — which is the defect this exists to close.
   */
  abstract declaredPaths(input: I): string[];

  /**
   * Abstract for the same reason: every built-in tool states the input its `execute` reads, so the
   * catalog can advertise it and the gate can answer a call that does not match it.
   */
  abstract readonly inputSchema: ToolInputSchema;

  /**
   * The gate's input check, narrowed to the fields this tool cannot run without, for a caller that
   * reached `execute` without the gate: a failed result naming what is missing or mistyped, where the
   * tool would otherwise throw from inside a syscall (`writeFile(tmp, undefined)`). `undefined` when
   * the input has them.
   */
  protected unusable(input: ToolInput, started: number): ToolResult | undefined {
    const problem = toolInputProblem(String(this.id), this.inputSchema, input, { requiredOnly: true });
    return problem === undefined ? undefined : this.err(problem, performance.now() - started);
  }

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
