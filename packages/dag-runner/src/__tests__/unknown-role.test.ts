import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId } from '@maf/types';
import { DagParser } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (D-07): a node that names an agentRole the role set does
// not define must refuse to parse. The old parser wrote the name into a `string` field and the
// dispatcher answered an unrecognised name with the default role — `coder`, which holds
// `fs.write`, `git.commit` and `patch.apply` — so a typo in a WORKFLOW.md became an escalation.

const RUN_ID = makeRunId('unknown-role');
const ROLES = testRoleResolver(['coder', 'reviewer'], 'coder');

test('DagParser refuses an agentRole the role set does not define', () => {
  assert.throws(
    () => DagParser.fromSpec({
      id: 'x',
      nodes: [{ id: 'n1', label: 'audit the change', agentRole: 'read-only-auditor' }],
    }, RUN_ID, ROLES),
    (e: Error) => {
      assert.match(e.message, /unknown agentRole "read-only-auditor"/);
      // The refusal names the roles that do exist, so the next attempt can be right.
      assert.match(e.message, /coder, reviewer/);
      return true;
    },
  );
});

test('an unknown role refuses the whole DAG, so no partial plan escapes', () => {
  assert.throws(
    () => DagParser.fromSpec({
      id: 'x',
      nodes: [
        { id: 'n1', label: 'code' },
        { id: 'n2', label: 'audit', agentRole: 'ninja' },
      ],
    }, RUN_ID, ROLES),
    /unknown agentRole "ninja"/,
  );
});

test('a defined agentRole is carried through as asked', () => {
  const dag = DagParser.fromSpec({
    id: 'x',
    nodes: [{ id: 'n1', label: 'audit', agentRole: 'reviewer' }],
  }, RUN_ID, ROLES);
  assert.equal([...dag.nodes.values()][0]?.agentRole, 'reviewer');
});

test('a node that names no role gets the resolver default', () => {
  const dag = DagParser.fromSpec({
    id: 'x',
    nodes: [{ id: 'n1', label: 'code' }],
  }, RUN_ID, ROLES);
  assert.equal([...dag.nodes.values()][0]?.agentRole, 'coder');
});
