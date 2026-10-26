import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeNodeId, makeRunId } from '@maf/types';
import type { FailurePattern } from '../FailurePatternDetector.js';
import { DagSynthesizer, MAX_SPEC_BYTES, MAX_SPEC_NODES, MAX_SPEC_EDGES } from '../DagSynthesizer.js';
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
  const text = JSON.stringify({
    id: 'two-node',
    nodes: [{ id: 'write', label: 'write' }, { id: 'audit', label: 'audit', agentRole: 'reviewer' }],
    edges: [{ from: 'write', to: 'audit' }],
  });
  await writeFile(file, text, 'utf8');
  const synth = new DagSynthesizer(ROLES);
  const first = await synth.fromFile(file, RUN_ID);
  const second = await synth.fromFile(file, RUN_ID);
  assert.equal(first.dag.id, 'two-node');
  assert.deepEqual(first.dag.edges.map((e) => e.id), second.dag.edges.map((e) => e.id));
  assert.deepEqual(first.dag.nodes.get(makeNodeId('audit'))?.dependencies, ['write']);
  // F4: the digest is of the bytes that were read, so the bundle names the exact text.
  assert.equal(first.sha256, crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
});

test('the recorded digest is the file bytes, and invalid UTF-8 is refused by name (R4)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-bytes-'));
  // A valid spec behind a UTF-8 BOM: decoding drops the BOM, so hashing the decoded string re-encoded
  // digests something the file does not contain. This is the case that tells the two apart.
  const body = Buffer.from('{"nodes":[{"id":"a","label":"café"}]}', 'utf8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
  const bomFile = path.join(dir, 'bom.json');
  await writeFile(bomFile, bom);
  const read = await new DagSynthesizer(ROLES).fromFile(bomFile, RUN_ID);
  assert.equal(read.sha256, crypto.createHash('sha256').update(bom).digest('hex'), 'the digest names the bytes on disk');
  assert.notEqual(read.sha256, crypto.createHash('sha256').update(body).digest('hex'),
    'it is not the digest of the decoded text — the BOM is in the file');
  assert.equal([...read.dag.nodes.values()][0]?.label, 'café');

  // Bytes that are not UTF-8 at all are refused as such, naming the file — not reported as a JSON
  // parse error caused by a replacement character.
  const badFile = path.join(dir, 'latin1.json');
  await writeFile(badFile, Buffer.from([0x7b, 0x22, 0x6e, 0xff, 0x7d]));
  await assert.rejects(
    () => new DagSynthesizer(ROLES).fromFile(badFile, RUN_ID),
    /latin1\.json is not valid UTF-8; a JSON workflow spec must be UTF-8 text/,
  );
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

test('a spec naming a prototype key is refused as a refusal, naming the file (G5)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-proto-'));
  // `metadata` is spread into node metadata downstream. A document with an own `__proto__`
  // anywhere is refused whole at parse time, so nothing downstream ever holds the poisoned object.
  const proto = path.join(dir, 'proto.json');
  await writeFile(
    proto,
    '{"nodes":[{"id":"a","label":"a","metadata":{"__proto__":{"polluted":true}}}]}',
    'utf8',
  );
  await assert.rejects(
    () => new DagSynthesizer(ROLES).fromFile(proto, RUN_ID),
    /proto\.json is refused: the JSON key "__proto__" names a prototype/,
  );
  // The refusal is not "not valid JSON": the file parses; naming a prototype is the objection.
  await assert.rejects(
    () => new DagSynthesizer(ROLES).fromFile(proto, RUN_ID),
    (err: unknown) => {
      assert.doesNotMatch(String(err), /could not read/);
      return true;
    },
  );
  // Depth does not matter: an edge-level key is refused by the same reviver.
  const deep = path.join(dir, 'deep.json');
  await writeFile(
    deep,
    '{"nodes":[{"id":"a","label":"a"}],"edges":[{"from":"a","to":"a","kind":{"constructor":{}}}]}',
    'utf8',
  );
  await assert.rejects(
    () => new DagSynthesizer(ROLES).fromFile(deep, RUN_ID),
    /deep\.json is refused: the JSON key "constructor" names a prototype/,
  );
});

// ── F5: a closed schema, refused at parse time ────────────────────────────────────────────────

function refuses(build: () => unknown, pattern: RegExp): void {
  assert.throws(build, pattern);
}

test('the container shapes are refused with a sentence, never a raw TypeError', () => {
  const synth = new DagSynthesizer(ROLES);
  refuses(() => synth.synthesize(null as never, RUN_ID), /must be a JSON object/);
  refuses(() => synth.synthesize([] as never, RUN_ID), /must be a JSON object/);
  refuses(() => synth.synthesize({} as never, RUN_ID), /must contain a JSON object with a "nodes" array/);
  refuses(() => synth.synthesize({ nodes: 'nope' } as never, RUN_ID), /must contain a JSON object with a "nodes" array/);
  refuses(() => synth.synthesize({ nodes: [null] } as never, RUN_ID), /node 0 is not an object/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a' }], edges: 'nope' } as never, RUN_ID), /"edges" must be an array/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a' }], edges: [null] } as never, RUN_ID), /edge 0 is not an object/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', metadata: [] }] } as never, RUN_ID), /"metadata" must be an object/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', dependencies: 'b' }] } as never, RUN_ID), /"dependencies" must be an array of node ids/);
});

test('ids, labels and timeouts are checked for type', () => {
  const synth = new DagSynthesizer(ROLES);
  refuses(() => synth.synthesize({ nodes: [] }, RUN_ID), /has no nodes; a plan needs at least one/);
  refuses(() => synth.synthesize({ nodes: [{ id: 7 as never, label: 'a' }] }, RUN_ID), /needs a non-empty string "id"/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: '' }] }, RUN_ID), /node "a" needs a non-empty string "label"/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: '5s' as never }] }, RUN_ID), /"timeoutMs" must be a whole number of milliseconds from 1 to 2147483647/);
  refuses(() => synth.synthesize({ id: 1 as never, nodes: [{ id: 'a', label: 'a' }] }, RUN_ID), /the spec's "id" must be a string/);
});

test('timeoutMs is bounded by the timer ceiling, and the ceiling itself is allowed (R3)', () => {
  const synth = new DagSynthesizer(ROLES);
  // The literal, not `MAX_TIMER_MS`: a test that imports the constant agrees with any value of it,
  // including a wrong one. Node fires any delay above 2147483647 after 1 ms, so a spec asking for
  // more asks for "at once" — the opposite of what it says.
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 0 }] }, RUN_ID), /from 1 to 2147483647/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: -1 }] }, RUN_ID), /from 1 to 2147483647/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 2147483648 }] }, RUN_ID), /from 1 to 2147483647/);
  const accepted = synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 2147483647 }] }, RUN_ID);
  assert.equal([...accepted.nodes.values()][0]?.timeoutMs, 2147483647, 'the ceiling is a valid timeout');
});

test('a fractional timeoutMs is refused: it is a number and in range, but not a whole millisecond (S4)', () => {
  const synth = new DagSynthesizer(ROLES);
  // `1.5` passes `typeof === 'number'`, `>= 1` and `<= MAX_TIMER_MS`; only the `Number.isSafeInteger`
  // guard refuses it. Without that guard a fractional timeout would reach the scheduler, where a
  // timer takes a whole number of milliseconds anyway — so the spec would ask for something it cannot
  // get. 0.5 (below 1 as an integer, but a positive fraction) is the lower companion.
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 1.5 }] }, RUN_ID), /from 1 to 2147483647/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 0.5 }] }, RUN_ID), /from 1 to 2147483647/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: NaN }] }, RUN_ID), /from 1 to 2147483647/);
  // A whole number in range is still accepted — the fraction, not the magnitude, is what this refuses.
  assert.equal(
    [...synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 1500 }] }, RUN_ID).nodes.values()][0]?.timeoutMs,
    1500,
  );
});

test('Infinity, a non-string agentRole and an empty edge endpoint are each refused (R8)', () => {
  const synth = new DagSynthesizer(ROLES);
  // `1e999` parses to Infinity: a number, and positive, so only the ceiling refuses it.
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', timeoutMs: 1e999 }] }, RUN_ID), /from 1 to 2147483647/);
  refuses(() => synth.synthesize({ nodes: [{ id: 'a', label: 'a', agentRole: 7 as never }] }, RUN_ID), /"agentRole" must be a string/);
  refuses(
    () => synth.synthesize({ nodes: [{ id: 'a', label: 'a' }], edges: [{ from: 'a', to: '' }] }, RUN_ID),
    /edge 0 needs a non-empty string "to"/,
  );
});

test('an unknown edge kind is refused, naming the kinds that are accepted', () => {
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({
      nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
      edges: [{ from: 'a', to: 'b', kind: 'blocks' }],
    }, RUN_ID),
    /unknown "kind" "blocks"; accepted kinds are data, control, review/,
  );
});

test('a dependency on a node the spec does not define is refused', () => {
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({ nodes: [{ id: 'a', label: 'a', dependencies: ['ghost'] }] }, RUN_ID),
    /node "a" depends on unknown node "ghost"/,
  );
});

test('a self-edge and a cycle are both refused before an id is minted', () => {
  const synth = new DagSynthesizer(ROLES);
  assert.throws(
    () => synth.synthesize({ nodes: [{ id: 'a', label: 'a' }], edges: [{ from: 'a', to: 'a' }] }, RUN_ID),
    /edge "a" -> "a" makes a node depend on itself/,
  );
  assert.throws(
    () => synth.synthesize({ nodes: [{ id: 'a', label: 'a', dependencies: ['a'] }] }, RUN_ID),
    /node "a" depends on itself/,
  );
  assert.throws(
    () => synth.synthesize({
      nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    }, RUN_ID),
    /dependency cycle among "a", "b"/,
  );
});

// ── F6: unknown keys are refused by name ─────────────────────────────────────────────────────

test('an unknown key is refused at node and spec level, naming it', () => {
  const synth = new DagSynthesizer(ROLES);
  // The typo that used to be dropped: `agnetRole` silently gave the node the default role.
  assert.throws(
    () => synth.synthesize({ nodes: [{ id: 'a', label: 'a', agnetRole: 'reviewer' } as never] }, RUN_ID),
    /node "a" has unknown key\(s\) "agnetRole"; a spec accepts "id", "label", "agentRole", "dependencies", "timeoutMs", "metadata"/,
  );
  assert.throws(
    () => synth.synthesize({ nodes: [{ id: 'a', label: 'a' }], config: {} } as never, RUN_ID),
    /the spec has unknown key\(s\) "config"; a spec accepts "id", "nodes", "edges"/,
  );
  assert.throws(
    () => synth.synthesize({ nodes: [{ id: 'a', label: 'a' }], edges: [{ from: 'a', to: 'a', label: 'x' }] } as never, RUN_ID),
    /edge 0 has unknown key\(s\) "label"/,
  );
});

test('a run-config key in a spec is refused, not ignored', () => {
  const synth = new DagSynthesizer(ROLES);
  for (const key of ['retry', 'inputs', 'outputs']) {
    assert.throws(
      () => synth.synthesize({ nodes: [{ id: 'a', label: 'a', [key]: {} }] } as never, RUN_ID),
      new RegExp(`node "a" has unknown key\\(s\\) "${key}"`),
    );
  }
});

// ── F7: the run's title rides on every node; recall is the caller's choice ───────────────────

test('every spec node carries the run title, so recall can find its failures', () => {
  const dag = new DagSynthesizer(ROLES).synthesize(
    { nodes: [{ id: 'a', label: 'write' }, { id: 'b', label: 'audit' }] },
    RUN_ID,
    { runTitle: 'Fix the sum' },
  );
  for (const node of dag.nodes.values()) {
    assert.equal(node.metadata['runTitle'], 'Fix the sum');
    // The node's own step, not the run's title: `taskDescription` is the prompt the dispatcher
    // hands the model, so every node in a spec has to keep its own.
    assert.equal(node.metadata['taskDescription'], node.label);
  }
  // An operator who names a node's task explicitly keeps it.
  const named = new DagSynthesizer(ROLES).synthesize(
    { nodes: [{ id: 'a', label: 'write', metadata: { taskDescription: 'write the parser' } }] },
    RUN_ID,
    { runTitle: 'Fix the sum' },
  );
  assert.equal(named.nodes.get(makeNodeId('a'))?.metadata['taskDescription'], 'write the parser');
});

test('recall inserts a review gate only when the caller passes patterns', () => {
  const spec = { nodes: [{ id: 'a', label: 'fix the parser' }] };
  const patterns: FailurePattern[] = [{
    taskLabel: 'parser', filePaths: ['src/parser.ts'], failureType: 'test', occurrences: 1, lastSeen: '2026-10-01',
  }];
  const withRecall = new DagSynthesizer(ROLES).synthesize(spec, RUN_ID, { avoidPatterns: patterns });
  assert.deepEqual(withRecall.config.reviewGateNodeIds, ['a']);
  // `--plan-from` passes none: the spec is the operator's plan and recall does not alter it.
  const withNone = new DagSynthesizer(ROLES).synthesize(spec, RUN_ID);
  assert.deepEqual(withNone.config.reviewGateNodeIds, []);
});

// ── F10: a spec that names no id gets one derived from its content ───────────────────────────

test('an unnamed spec gets a sha256 id from its content, stable across reads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-'));
  const one = path.join(dir, 'one.json');
  const two = path.join(dir, 'two.json');
  await writeFile(one, JSON.stringify({ nodes: [{ id: 'a', label: 'write' }] }), 'utf8');
  await writeFile(two, JSON.stringify({ nodes: [{ id: 'a', label: 'audit' }] }), 'utf8');
  const synth = new DagSynthesizer(ROLES);
  const first = await synth.fromFile(one, RUN_ID);
  const again = await synth.fromFile(one, RUN_ID);
  const other = await synth.fromFile(two, RUN_ID);
  assert.match(first.dag.id, /^[0-9a-f]{64}$/);
  assert.equal(first.dag.id, again.dag.id, 'the same content mints the same id');
  assert.notEqual(first.dag.id, other.dag.id, 'different content mints a different id');
});

// ── F11: the caps ────────────────────────────────────────────────────────────────────────────

// The caps are checked against literal numbers, not the exported constants (R7): a test that reads
// the constant it is checking agrees with any value of it, including one the documentation would
// not recognise. `1048576` is 1 MiB, `200` nodes and `2000` edges are what the fragment states.
test('the caps are the numbers the documentation states (R7)', () => {
  assert.equal(MAX_SPEC_BYTES, 1048576);
  assert.equal(MAX_SPEC_NODES, 200);
  assert.equal(MAX_SPEC_EDGES, 2000);
});

test('a spec larger than the byte cap is refused before it is parsed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-'));
  const big = path.join(dir, 'big.json');
  // Not JSON at all: the size is read from the file's metadata, so the cap answers first.
  await writeFile(big, 'x'.repeat(1048577), 'utf8');
  await assert.rejects(
    () => new DagSynthesizer(ROLES).fromFile(big, RUN_ID),
    /may be at most 1048576/,
  );
  // The cap itself is a size a spec may have.
  const exact = path.join(dir, 'exact.json');
  const json = JSON.stringify({ nodes: [{ id: 'a', label: 'a' }] });
  await writeFile(exact, json + ' '.repeat(1048576 - json.length), 'utf8');
  assert.equal((await new DagSynthesizer(ROLES).fromFile(exact, RUN_ID)).dag.nodes.size, 1);
});

test('the oversize refusal reads the size from stat, not from the loaded bytes (S4)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-stat-'));
  const big = path.join(dir, 'oversize.json');
  // One byte past the cap, and valid-JSON-shaped so that a reader which loaded and parsed it first
  // would raise a *parse* error, not a size one. The refusal instead names the exact on-disk byte
  // count — `it is 1048577 bytes` — which can only come from `stat`, before the bytes are read. So
  // the cap answers from metadata, and a file far past a plan's size is never loaded.
  const size = MAX_SPEC_BYTES + 1;
  const prefix = '{"nodes":[{"id":"a","label":"';
  const body = prefix + 'x'.repeat(size - prefix.length - 4) + '"}]}';
  assert.equal(Buffer.byteLength(body, 'utf8'), size, 'the fixture is exactly one byte over the cap');
  await writeFile(big, body, 'utf8');
  await assert.rejects(
    () => new DagSynthesizer(ROLES).fromFile(big, RUN_ID),
    (e: Error) => {
      assert.match(e.message, new RegExp(`it is ${size} bytes; a spec may be at most ${MAX_SPEC_BYTES}`));
      return true;
    },
  );
});

test('a UTF-8 byte-order mark is accepted and stripped, and the digest is over the bytes BOM included (S3)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-spec-bom-'));
  const spec = path.join(dir, 'bom.json');
  const body = Buffer.from(JSON.stringify({ nodes: [{ id: 'n1', label: 'Fix it' }] }), 'utf8');
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
  await writeFile(spec, withBom);
  const read = await new DagSynthesizer(ROLES).fromFile(spec, RUN_ID);
  // Accepted: the BOM did not make the JSON parse fail, and the node was read.
  assert.equal([...read.dag.nodes.keys()][0], 'n1');
  // Stripped: the first node's label is exactly "Fix it", not a label behind a U+FEFF, and the DAG
  // id (content-derived, no spec id) is the sha256 of the BOM-less object — the BOM is not content.
  assert.equal([...read.dag.nodes.values()][0]?.label, 'Fix it');
  // The recorded digest is over the file's bytes, BOM included — the record names what is on disk.
  assert.equal(read.sha256, crypto.createHash('sha256').update(withBom).digest('hex'),
    'the digest is over the file bytes, BOM included');
  assert.notEqual(read.sha256, crypto.createHash('sha256').update(body).digest('hex'),
    'it is not the digest of the BOM-stripped bytes');
});

test('a spec with more nodes than the cap is refused, stating the cap', () => {
  const nodes = Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, label: `node ${i}` }));
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({ nodes }, RUN_ID),
    /has 201 nodes; at most 200 are accepted/,
  );
  // The cap itself is a plan the synthesizer accepts — the bound is not off by one.
  assert.equal(new DagSynthesizer(ROLES).synthesize({ nodes: nodes.slice(0, 200) }, RUN_ID).nodes.size, 200);
});

test('a spec with more edges than the cap is refused, stating the cap (R7)', () => {
  const nodes = [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }];
  const edges = Array.from({ length: 2001 }, () => ({ from: 'a', to: 'b' }));
  assert.throws(
    () => new DagSynthesizer(ROLES).synthesize({ nodes, edges }, RUN_ID),
    /has 2001 edges; at most 2000 are accepted/,
  );
  assert.equal(new DagSynthesizer(ROLES).synthesize({ nodes, edges: edges.slice(0, 2000) }, RUN_ID).edges.length, 2000);
});
