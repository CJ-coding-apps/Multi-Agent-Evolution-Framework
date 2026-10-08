import type { PolicyDecision } from '@maf/types';
import { VerdictError } from '@maf/types';
import type { Refusal } from './PolicyEngine.js';

export class PolicyViolationError extends VerdictError {
  constructor(public readonly decision: Refusal) {
    super(`Policy violation: ${decision.verdict} — ${decision.reason}`);
    this.name = 'PolicyViolationError';
  }
}

export class ViolationHandler {
  // Throws PolicyViolationError for Deny/Escalate/Indeterminate; returns normally for Allow.
  // Indeterminate is a refusal: the call does not proceed, and it is not a question for a human.
  handle(decision: PolicyDecision): void {
    if (decision.verdict === 'Allow') return;
    throw new PolicyViolationError(decision);
  }

  // Returns true if the decision is a soft escalation that can be approved.
  // An Indeterminate is deliberately not escalatable — there is no decision to approve, and
  // answering one with approval would turn "the policy could not be evaluated" into permission.
  isEscalatable(decision: PolicyDecision): boolean {
    return decision.verdict === 'Escalate';
  }

  static isDeny(err: unknown): err is PolicyViolationError {
    return err instanceof PolicyViolationError && err.decision.verdict === 'Deny';
  }

  static isEscalation(err: unknown): err is PolicyViolationError {
    return err instanceof PolicyViolationError && err.decision.verdict === 'Escalate';
  }

  static isIndeterminate(err: unknown): err is PolicyViolationError {
    return err instanceof PolicyViolationError && err.decision.verdict === 'Indeterminate';
  }
}
