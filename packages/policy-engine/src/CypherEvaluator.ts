import type { ToolId, ToolInput, ToolContext, GraphQueryRunner } from '@maf/types';
import { bindPolicyTemplate } from './policyTemplate.js';

export class CypherEvaluator {
  constructor(private readonly graph: GraphQueryRunner) {}

  /**
   * True when the template's query returns rows.
   *
   * It used to expose `interpolate()`, which built the query by substituting values into it —
   * the fourth copy of the quote-doubling escaper, and the one a caller could reach directly.
   * There is no such method now: the template keeps its `$names`, the values are bound, and a
   * query the graph cannot answer is an error rather than `false`, because a `false` here is
   * read by a `Deny` rule as "carry on".
   */
  async evaluate(
    cypherTemplate: string,
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
  ): Promise<boolean> {
    const rows = await this.graph.run(
      bindPolicyTemplate(cypherTemplate, {
        tool:   toolId,
        path:   String(input['path'] ?? input['filePath'] ?? ''),
        runId:  ctx.runId,
        taskId: ctx.taskId,
      }),
    );
    return rows.length > 0;
  }
}
