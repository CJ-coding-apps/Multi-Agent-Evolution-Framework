import type { PolicyDecision } from '@maf/types';

export class PolicyViolationError extends Error {
  constructor(public readonly decision: PolicyDecision & { verdict: 'Deny' | 'Escalate' }) {
    super(`Policy violation: ${decision.verdict} — ${decision.reason}`);
    this.name = 'PolicyViolationError';
  }
}

export class ViolationHandler {
  // Throws PolicyViolationError for Deny/Escalate; returns normally for Allow.
  handle(decision: PolicyDecision): void {
    if (decision.verdict === 'Allow') return;
    throw new PolicyViolationError(decision);
  }

  // Returns true if the decision is a soft escalation that can be approved
  isEscalatable(decision: PolicyDecision): boolean {
    return decision.verdict === 'Escalate';
  }

  static isDeny(err: unknown): err is PolicyViolationError {
    return err instanceof PolicyViolationError && err.decision.verdict === 'Deny';
  }

  static isEscalation(err: unknown): err is PolicyViolationError {
    return err instanceof PolicyViolationError && err.decision.verdict === 'Escalate';
  }
}
