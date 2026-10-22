import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNodeId, makeRunId } from '@maf/types';
import { DagParser } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// WP-3.9 F10. A workflow spec read as JSON never passes through `parseYamlDocument`, so the
// refusal of prototype keys is repeated in `DagParser` rather than assumed. The reviver refuses
// the key wherever it sits — the document, a node, the config — because a spec is copied field by
// field downstream and the copy is where an own `__proto__` becomes a prototype.

const RUN_ID = makeRunId('run-spec-keys');
const ROLES = testRoleResolver(['planner', 'coder'], 'coder');

test('a spec that names a prototype key is refused at any depth, and named', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    for (const text of [
      `{"nodes": [], "${key}": {"polluted": true}}`,
      `{"nodes": [{"id": "n", "label": "n", "agentRole": "coder", "${key}": 1}]}`,
      `{"nodes": [], "config": {"${key}": {"maxConcurrent": 99}}}`,
    ]) {
      assert.throws(() => DagParser.fromYamlText(text, RUN_ID, ROLES), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(key), err.message);
        assert.match(err.message, /names a prototype/);
        // A refused key is not a parse failure, and must not be reported as one.
        assert.doesNotMatch(err.message, /could not parse workflow spec as JSON/);
        return true;
      });
    }
  }
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.equal(({} as Record<string, unknown>)['maxConcurrent'], undefined);
});

test('the words as values are ordinary spec content, not refused', () => {
  const dag = DagParser.fromYamlText(JSON.stringify({
    nodes: [{ id: 'n', label: 'constructor', agentRole: 'coder' }],
    id: 'prototype',
  }), RUN_ID, ROLES);
  assert.equal(dag.nodes.get(makeNodeId('n'))?.label, 'constructor');
});
