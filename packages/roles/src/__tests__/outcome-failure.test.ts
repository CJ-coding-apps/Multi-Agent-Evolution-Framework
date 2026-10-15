import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeFailureKind, outcomeFailureDetail, makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyViolationError, PolicyViolationHandlerError } from '@maf/policy-engine';

// R8: `outcomeFailureKind` keys the policy case on the base `VerdictError`, because the tree carries
// *two* exported `PolicyViolationError` classes — policy-engine's `PolicyEngine` and `ViolationHandler`,
// the latter re-exported as `PolicyViolationHandlerError` — and `@maf/types` cannot depend on
// `@maf/policy-engine` to name either. The dag-runner test (which cannot import this package) exercises a
// bare `VerdictError`; these two are the classes a run actually throws, so this pins that both classify
// as `'policy_violation'` and not as some other kind. A future `VerdictError` subclass that is not a gate
// or review refusal would still read as `'policy_violation'` here — that is why `VerdictError` carries a
// note that a new subclass needs its own kind in `outcomeFailureKind`.

test('R8: both real PolicyViolationError classes classify as policy_violation', () => {
  const decision = { verdict: 'Deny' as const, reason: 'deny-env-files refused the write' };
  const engineClass = new PolicyViolationError(decision);
  const handlerClass = new PolicyViolationHandlerError(decision);
  assert.equal(outcomeFailureKind(engineClass), 'policy_violation', 'policy-engine PolicyViolationError');
  assert.equal(outcomeFailureKind(handlerClass), 'policy_violation', 'ViolationHandler PolicyViolationHandlerError');
});

// A11: a policy refusal's outcome failure names the rule and tool its `decision` names, read structurally
// because `@maf/types` cannot import the engine. The rule id is read exactly where the F10 clause in the
// dispatcher (`refusingRuleId`) reads it: a `Deny` or an `Indeterminate` on the decision, an `Escalate` on
// the request the gate was shown. A decision that names no rule adds none — the outcome does not invent
// one.

test('A11: a denied refusal names its rule on the outcome failure', () => {
  const refusal = new PolicyViolationError({
    verdict: 'Deny', reason: 'deny-env-files refused the write', ruleId: 'deny-env-files',
  });
  assert.deepEqual(outcomeFailureDetail(refusal), { kind: 'policy_violation', ruleId: 'deny-env-files' });
});

test('A11: an escalated refusal names the rule on the approval request it was shown', () => {
  const refusal = new PolicyViolationError({
    verdict: 'Escalate', reason: 'a push needs a human',
    approvalRequest: {
      id: 'req-1', runId: makeRunId('r'), taskId: makeTaskId('t'), requestedBy: makeAgentId('a'),
      policyRuleId: 'ask-before-push', description: 'push to a protected branch', createdAt: new Date(0),
    },
  });
  assert.deepEqual(outcomeFailureDetail(refusal), { kind: 'policy_violation', ruleId: 'ask-before-push' });
});

test('A11: an indeterminate refusal names the rule whose evaluation failed', () => {
  const refusal = new PolicyViolationError({
    verdict: 'Indeterminate', reason: 'the graph could not answer', ruleId: 'deny-graph-writes',
  });
  assert.deepEqual(outcomeFailureDetail(refusal), { kind: 'policy_violation', ruleId: 'deny-graph-writes' });
});

test('A11: a refusal whose decision names no rule adds no rule to the outcome failure', () => {
  const refusal = new PolicyViolationError({ verdict: 'Deny', reason: 'refused without naming a rule' });
  assert.deepEqual(outcomeFailureDetail(refusal), { kind: 'policy_violation' });
});
