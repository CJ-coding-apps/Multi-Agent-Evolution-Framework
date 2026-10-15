import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeFailureKind } from '@maf/types';
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
