import type { Dag } from '@maf/types';

/** Input that is not a schedulable DAG at all — thrown before any node is dispatched. */
export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}

/**
 * 1, 2, 3, … and nothing else. `value < 1` is not this test: NaN, `"four"` from a JSON spec and
 * `undefined` all compare false against 1, so each of them passed it.
 */
export function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** A value as a refusal should show it: a string is quoted and named, so `"4"` and `4` differ. */
export function describeValue(value: unknown): string {
  return typeof value === 'string' ? `the string ${JSON.stringify(value)}` : String(value);
}

// Reject *malformed input* up front, so `Unclaimed` never doubles as a verdict for
// garbage. Structure that is well-formed but cannot complete — a cycle, or a
// dependency that failed — is not an error here: it is what RunOutcome reports.
export function validateDag(dag: Dag): void {
  if (dag.nodes.size === 0) {
    throw new DagValidationError('DAG has no nodes');
  }

  // A limit the scheduler cannot count up to dispatches nothing, and the dispatch loop then
  // spins without ever awaiting, so the run neither progresses nor ends.
  if (!isPositiveSafeInteger(dag.config.maxConcurrent)) {
    throw new DagValidationError(
      `maxConcurrent must be a positive safe integer (1 or more), got ${describeValue(dag.config.maxConcurrent)}.`,
    );
  }

  for (const node of dag.nodes.values()) {
    for (const dep of node.dependencies) {
      if (!dag.nodes.has(dep)) {
        throw new DagValidationError(`node "${node.id}" depends on unknown node "${dep}"`);
      }
    }

    // Refused here rather than when the node runs, so a bad policy on one node cannot let its
    // siblings start before the plan is known to be garbage.
    const maxAttempts = node.retryPolicy.maxAttempts;
    if (!isPositiveSafeInteger(maxAttempts)) {
      throw new DagValidationError(
        `node "${node.id}" retryPolicy.maxAttempts must be a positive safe integer (1 means no retry), ` +
        `got ${describeValue(maxAttempts)}.`,
      );
    }
  }
}
