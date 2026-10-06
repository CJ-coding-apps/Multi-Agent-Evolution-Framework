import type { Dag } from '@maf/types';

/** Input that is not a schedulable DAG at all — thrown before any node is dispatched. */
export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}

// Reject *malformed input* up front, so `Unclaimed` never doubles as a verdict for
// garbage. Structure that is well-formed but cannot complete — a cycle, or a
// dependency that failed — is not an error here: it is what RunOutcome reports.
export function validateDag(dag: Dag): void {
  if (dag.nodes.size === 0) {
    throw new DagValidationError('DAG has no nodes');
  }

  // A non-positive concurrency limit dispatches nothing and never terminates.
  if (dag.config.maxConcurrent < 1) {
    throw new DagValidationError(`maxConcurrent must be at least 1, got ${dag.config.maxConcurrent}`);
  }

  for (const node of dag.nodes.values()) {
    for (const dep of node.dependencies) {
      if (!dag.nodes.has(dep)) {
        throw new DagValidationError(`node "${node.id}" depends on unknown node "${dep}"`);
      }
    }
  }
}
