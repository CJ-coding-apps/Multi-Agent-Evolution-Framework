import type { GraphQuery, QueryParamValue, RunId, TaskId, ToolId } from '@maf/types';

/**
 * Turns a policy rule's Cypher template into a query whose values are bound.
 *
 * A template written by an operator may name any of `$tool`, `$path`, `$runId`, `$taskId` — and
 * only those. This reads *which* of them the template names, because Kùzu refuses a statement
 * given a parameter it does not reference, so binding all four unconditionally would break every
 * template that uses one. Reading the names is not interpolation: the template keeps its `$name`
 * placeholders and the values travel in `params`.
 *
 * A template that names anything else is refused, loudly. The previous code left the unknown
 * `$name` in place for the driver to trip over, and a rule whose query never resolves is a rule
 * that never fires — which, for a `Deny` rule, is exactly the fail-open A2-3 exists to remove.
 */
export function bindPolicyTemplate(
  template: string,
  values: { tool: ToolId; path: string; runId: RunId; taskId: TaskId },
): GraphQuery {
  const available: Record<string, QueryParamValue> = {
    tool:   values.tool,
    path:   values.path,
    runId:  values.runId,
    taskId: values.taskId,
  };

  const params: Record<string, QueryParamValue> = {};
  for (const match of template.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1]!;
    const value = available[name];
    if (value === undefined) {
      throw new Error(
        `memoryPattern names $${name}, which is not bindable. ` +
        `A policy query may bind ${Object.keys(available).map((n) => `$${n}`).join(', ')}.`,
      );
    }
    params[name] = value;
  }

  return { cypher: template, params };
}
