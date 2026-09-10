import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyDecision } from '@maf/types';
import { ViolationHandler, PolicyViolationError } from '../ViolationHandler.js';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';

const escalation = (reason: string): PolicyDecision => ({
  verdict: 'Escalate',
  reason,
  approvalRequest: {
    id: 'req-1',
    runId: makeRunId('r1'),
    taskId: makeTaskId('t1'),
    requestedBy: makeAgentId('a1'),
    toolId: makeToolId('shell.exec'),
    policyRuleId: 'rule-1',
    description: 'needs approval',
    createdAt: new Date(),
  },
});

const handler = new ViolationHandler();

test('handle() returns normally for Allow', () => {
  assert.doesNotThrow(() => handler.handle({ verdict: 'Allow' }));
});

test('handle() throws PolicyViolationError for Deny, carrying the decision', () => {
  const decision: PolicyDecision = { verdict: 'Deny', reason: 'blocked path' };
  try {
    handler.handle(decision);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof PolicyViolationError);
    assert.equal(err.decision.verdict, 'Deny');
    assert.equal(err.decision.reason, 'blocked path');
    assert.equal(err.name, 'PolicyViolationError');
    assert.match(err.message, /Deny/);
  }
});

test('handle() throws for Escalate', () => {
  assert.throws(
    () => handler.handle(escalation('needs approval')),
    PolicyViolationError,
  );
});

test('isEscalatable() is true only for Escalate decisions', () => {
  assert.equal(handler.isEscalatable(escalation('r')), true);
  assert.equal(handler.isEscalatable({ verdict: 'Deny', reason: 'r' }), false);
  assert.equal(handler.isEscalatable({ verdict: 'Allow' }), false);
});

test('static isDeny()/isEscalation() discriminate error kinds', () => {
  const denyErr = (() => {
    try { handler.handle({ verdict: 'Deny', reason: 'no' }); } catch (e) { return e; }
    return undefined;
  })();
  const escErr = (() => {
    try { handler.handle(escalation('ask')); } catch (e) { return e; }
    return undefined;
  })();

  assert.equal(ViolationHandler.isDeny(denyErr), true);
  assert.equal(ViolationHandler.isEscalation(denyErr), false);
  assert.equal(ViolationHandler.isDeny(escErr), false);
  assert.equal(ViolationHandler.isEscalation(escErr), true);
});

test('isDeny()/isEscalation() reject non-PolicyViolationError values', () => {
  assert.equal(ViolationHandler.isDeny(new Error('plain')), false);
  assert.equal(ViolationHandler.isEscalation('string'), false);
  assert.equal(ViolationHandler.isDeny(undefined), false);
});
