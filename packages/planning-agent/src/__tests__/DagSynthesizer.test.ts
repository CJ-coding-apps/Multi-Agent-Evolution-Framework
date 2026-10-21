import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeNodeId, makeRunId } from '@maf/types';
import { DagSynthesizer } from '../DagSynthesizer.js';
import { rolesOf } from './roleResolver.js';

// ORACLE (D-07): the synthesizer is the second place a role name
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

// ── WP-3.6: the spec is a plan, so it is read once and refused in full ──────────────────────────

test('a duplicate node id is refused, not silently collapsed', () => {
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({
      nodes: [{ id: 'n1', label: 'first' }, { id: 'n1', label: 'second' }],
    }, RUN_ID),
    /duplicate node id "n1"/,
  );
});

test('an edge makes its target depend on its source', () => {
  const dag = new DagSynthesizer(ROLES).synthesize({
    nodes: [{ id: 'a', label: 'write' }, { id: 'b', label: 'audit', agentRole: 'reviewer' }],
    edges: [{ from: 'a', to: 'b' }],
  }, RUN_ID);
  assert.deepEqual(dag.nodes.get(makeNodeId('b'))?.dependencies, ['a']);
  assert.deepEqual(dag.nodes.get(makeNodeId('a'))?.dependencies, []);
});

test('an edge naming a node the spec does not define is refused', () => {
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({
      nodes: [{ id: 'a', label: 'write' }],
      edges: [{ from: 'a', to: 'ghost' }],
    }, RUN_ID),
    /DagSynthesizer: edge names unknown node "ghost" \(to\)/,
  );
});

test('a spec file yields the same DAG on every read, with no model in the path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-'));
  const file = path.join(dir, 'two-node.json');
  await writeFile(file, JSON.stringify({
    id: 'two-node',
    nodes: [{ id: 'write', label: 'write' }, { id: 'audit', label: 'audit', agentRole: 'reviewer' }],
    edges: [{ from: 'write', to: 'audit' }],
  }), 'utf8');
  const synth = new DagSynthesizer(ROLES);
  const first = await synth.fromFile(file, RUN_ID);
  const second = await synth.fromFile(file, RUN_ID);
  assert.equal(first.id, 'two-node');
  assert.deepEqual(first.edges.map((e) => e.id), second.edges.map((e) => e.id));
  assert.deepEqual(first.nodes.get(makeNodeId('audit'))?.dependencies, ['write']);
});

test('a spec file that is not a workflow spec is refused by name', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-'));
  const notJson = path.join(dir, 'not.json');
  await writeFile(notJson, 'nodes: [', 'utf8');
  await assert.rejects(() => new DagSynthesizer(ROLES).fromFile(notJson, RUN_ID), /could not read .*not\.json as a JSON workflow spec/);

  const noNodes = path.join(dir, 'no-nodes.json');
  await writeFile(noNodes, '{"id":"x"}', 'utf8');
  await assert.rejects(() => new DagSynthesizer(ROLES).fromFile(noNodes, RUN_ID), /must contain a JSON object with a "nodes" array/);
});
