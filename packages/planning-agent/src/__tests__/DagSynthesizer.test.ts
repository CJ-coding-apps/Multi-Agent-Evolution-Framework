import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId } from '@maf/types';
import { DagSynthesizer } from '../DagSynthesizer.js';
import { rolesOf } from './roleResolver.js';

// ORACLE (DEFECT_SWEEP_2026-09-25.md D-07): the synthesizer is the second place a role name
// enters a DAG, and it did no checking at all — it wrote `n.agentRole ?? defaultRole` into a
// `string` field. A name the role set does not define is refused here too, for the same
// reason: the dispatcher's answer to an unrecognised name was the default *writer*.

const RUN_ID = makeRunId('synthesize-role');
const ROLES = rolesOf(['coder', 'reviewer']);

test('a synthesised node carries the role it asked for', () => {
  const dag = new DagSynthesizer(ROLES).synthesize({
    nodes: [{ id: 'n1', label: 'audit', agentRole: 'reviewer' }],
  }, RUN_ID);
  assert.equal([...dag.nodes.values()][0]?.agentRole, 'reviewer');
});

test('a node that names no role gets the resolver default', () => {
  const dag = new DagSynthesizer(ROLES).singleNode('code it', RUN_ID);
  assert.equal([...dag.nodes.values()][0]?.agentRole, 'coder');
});

test('an unknown agentRole refuses the synthesis', () => {
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({
      nodes: [{ id: 'n1', label: 'audit', agentRole: 'read-only-auditor' }],
    }, RUN_ID),
    (e: Error) => {
      assert.match(e.message, /unknown agentRole "read-only-auditor"/);
      assert.match(e.message, /coder, reviewer/);
      return true;
    },
  );
});
