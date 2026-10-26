import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNodeId, makeRunId } from '@maf/types';
import { DagParser } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (WP-3.6): a spec that expresses its order through `edges` is honoured. The parser kept
// the edges beside the DAG, and the scheduler reads `dependencies`, so `a -> b` ran a and b
// concurrently — a plan read from a file said one thing and the run did another.

const RUN_ID = makeRunId('plan-spec');
const ROLES = testRoleResolver(['coder', 'reviewer'], 'coder');

const TWO_NODES = {
  id: 'two-node',
  nodes: [
    { id: 'write', label: 'write the change' },
    { id: 'audit', label: 'audit the change', agentRole: 'reviewer' },
  ],
  edges: [{ from: 'write', to: 'audit' }],
};

test('an edge makes its target depend on its source', () => {
  const dag = DagParser.fromSpec(TWO_NODES, RUN_ID, ROLES);
  assert.deepEqual(dag.nodes.get(makeNodeId('audit'))?.dependencies, ['write']);
  assert.deepEqual(dag.nodes.get(makeNodeId('write'))?.dependencies, []);
});

test('an edge and a listed dependency agree rather than duplicate', () => {
  const dag = DagParser.fromSpec({
    id: 'both',
    nodes: [
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b', dependencies: ['a'] },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }, RUN_ID, ROLES);
  assert.deepEqual(dag.nodes.get(makeNodeId('b'))?.dependencies, ['a'], 'one entry, not two');
});

test('an edge naming a node the spec does not define is refused at parse time', () => {
  assert.throws(
    () => DagParser.fromSpec({
      id: 'bad-edge',
      nodes: [{ id: 'a', label: 'a' }],
      edges: [{ from: 'a', to: 'ghost' }],
    }, RUN_ID, ROLES),
    /DagParser: edge names unknown node "ghost" \(to\)/,
  );
  assert.throws(
    () => DagParser.fromSpec({
      id: 'bad-edge',
      nodes: [{ id: 'a', label: 'a' }],
      edges: [{ from: 'ghost', to: 'a' }],
    }, RUN_ID, ROLES),
    /DagParser: edge names unknown node "ghost" \(from\)/,
  );
});

test('the same spec parses to the same DAG id and edge ids on every call', () => {
  const first = DagParser.fromSpec(TWO_NODES, RUN_ID, ROLES);
  const second = DagParser.fromSpec(TWO_NODES, RUN_ID, ROLES);
  assert.equal(first.id, 'two-node');
  assert.deepEqual(first.edges.map((e) => e.id), second.edges.map((e) => e.id));
  assert.deepEqual([...first.nodes.keys()], [...second.nodes.keys()]);
});

test('a spec that names no id gets an id derived from its content, not the clock', () => {
  const first = DagParser.fromSpec({ nodes: TWO_NODES.nodes, edges: TWO_NODES.edges }, RUN_ID, ROLES);
  const second = DagParser.fromSpec({ nodes: TWO_NODES.nodes, edges: TWO_NODES.edges }, RUN_ID, ROLES);
  assert.match(first.id, /^[0-9a-f]{64}$/);
  assert.equal(first.id, second.id);
});
