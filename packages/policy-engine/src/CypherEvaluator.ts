import type { ToolId, ToolInput, ToolContext } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';

export class CypherEvaluator {
  constructor(private readonly graph: MemoryGraph) {}

  async evaluate(
    cypherTemplate: string,
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
  ): Promise<boolean> {
    const cypher = this.interpolate(cypherTemplate, toolId, input, ctx);
    try {
      const rows = await this.graph.query(cypher, {});
      return (rows as unknown[]).length > 0;
    } catch {
      return false;
    }
  }

  interpolate(
    template: string,
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
  ): string {
    const path = String(input['path'] ?? input['filePath'] ?? '');
    return template
      .replace(/\$tool/g,   `'${toolId.replace(/'/g, "''")}'`)
      .replace(/\$path/g,   `'${path.replace(/'/g, "''")}'`)
      .replace(/\$runId/g,  `'${ctx.runId.replace(/'/g, "''")}'`)
      .replace(/\$taskId/g, `'${ctx.taskId.replace(/'/g, "''")}'`);
  }
}
