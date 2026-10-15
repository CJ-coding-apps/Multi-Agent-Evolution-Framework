import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SlsaBuilder, SlsaInvocation } from '@maf/types';
import { makeRunId, makeAgentId, makeToolId, makeTaskId } from '@maf/types';
import { Attestor } from '../Attestor.js';

// Attestor.bundle only touches MemoryGraph via record(), which we don't exercise here.
const stubGraph = { addNode: async () => undefined } as never;

test('recordSecurityFindings flows into bundle output and signature payload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const runId = makeRunId('r-1');
    const attestor = new Attestor(runId, stubGraph, dir, { secret: 'test-secret' });

    attestor.recordSecurityFindings('node-1', {
      findings: [{
        severity: 'high', category: 'SQLi', file: 'src/db.ts', rationale: 'r', remediation: 'rm',
      }],
      summary: 'one issue',
      passed: false,
    });

    const builder: SlsaBuilder = { id: 'b@1', modelVersion: 'v' };
    const invocation: SlsaInvocation = {
      configSource: { uri: '', digest: { sha256: '' } },
      parameters: {},
      environment: {},
    };
    const bundle = await attestor.bundle(builder, invocation, [], { status: 'Succeeded', unscheduled: [] });

    assert.equal(bundle.securityFindings?.length, 1);
    assert.equal(bundle.securityFindings?.[0]?.nodeId, 'node-1');
    assert.equal(bundle.securityFindings?.[0]?.result.passed, false);
    assert.ok(bundle.signature, 'bundle must be signed');
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true, 'signature verifies against same secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundle without recordSecurityFindings has empty securityFindings list', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const runId = makeRunId('r-2');
    const attestor = new Attestor(runId, stubGraph, dir, { secret: 'test-secret' });
    const bundle = await attestor.bundle(
      { id: 'b@1', modelVersion: 'v' },
      { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
      [],
      { status: 'Succeeded', unscheduled: [] },
    );
    assert.ok(Array.isArray(bundle.securityFindings));
    assert.equal(bundle.securityFindings?.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ORACLE (F4, F6 of the 0.3.1 sweep). A bundle now carries the model-facing surface of each governed
// turn and the policy that was in force. Both are optional and both are omitted when unrecorded, so a
// bundle without them parses — and, more to the point, a reader can tell "not recorded" from
// "recorded as empty": a run with no policy file and a run whose policy never fired must not look alike.

const INVOCATION: SlsaInvocation = { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} };
const BUILDER: SlsaBuilder = { id: 'b@1', modelVersion: 'v' };

test('recordPolicyInForce and recordModelSurface flow into the signed bundle, under the signature', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const attestor = new Attestor(makeRunId('r-f46'), stubGraph, dir, { secret: 'test-secret' });
    attestor.recordPolicyInForce({
      source: '.maf/policy.yaml', sha256: 'abc123', ruleCount: 1,
      rules: [{ id: 'protect-secrets', effect: 'Deny', matcher: 'toolId=fs.write pathGlob=.env' }],
      counts: { allow: 3, deny: 1, escalate: 0, indeterminate: 0 },
    });
    attestor.recordModelSurface({
      role: 'coder', taskId: 't1' as never, turn: 1,
      systemPromptSha256: 'f'.repeat(64), toolCatalog: 'AVAILABLE TOOLS: (none)', argv: ['--print', '-p', '--', '<prompt: 4 bytes, sha256 ' + 'a'.repeat(64) + '>'],
    });

    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });

    assert.deepEqual(bundle.policyInForce?.counts, { allow: 3, deny: 1, escalate: 0, indeterminate: 0 });
    assert.equal(bundle.policyInForce?.sha256, 'abc123');
    assert.equal(bundle.modelSurfaces?.length, 1);
    assert.equal(bundle.modelSurfaces?.[0]?.role, 'coder');
    // The fields are inside the signed payload, not beside it: re-wrapping the predicate verifies.
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bundle with neither recorded omits both fields entirely, rather than writing empty ones', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const attestor = new Attestor(makeRunId('r-f46-bare'), stubGraph, dir, { secret: 'test-secret' });
    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });

    assert.equal('policyInForce' in bundle, false, 'unrecorded, not recorded-as-empty');
    assert.equal('modelSurfaces' in bundle, false);
    assert.equal('executionTiers' in bundle, false, 'the F7 tier record is optional the same way');
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true, 'and the bundle still signs and verifies');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordExecutionTier flows into the signed bundle, last-wins per node, so a retry reads as one node', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const attestor = new Attestor(makeRunId('r-f7'), stubGraph, dir, { secret: 'test-secret' });
    // The F7 finding: a Deny rule scoped to a cli-tier role is in force and unreachable, and only the
    // recorded tier shows which node the rule failed to reach. A reader and a writer, both cli-tier.
    attestor.recordExecutionTier({ nodeId: 'n1', role: 'reviewer', tier: 'cli', adapter: 'gemini' });
    attestor.recordExecutionTier({ nodeId: 'n2', role: 'coder', tier: 'cli', adapter: 'codex', fellBackFrom: 'in-process' });
    // A retried node records once per attempt; the last attempt is the one that stands.
    attestor.recordExecutionTier({ nodeId: 'n1', role: 'reviewer', tier: 'in-process', adapter: 'claude' });

    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });

    assert.equal(bundle.executionTiers?.length, 2, 'one entry per node, not one per attempt');
    assert.deepEqual(
      bundle.executionTiers?.find((e) => e.nodeId === 'n1'),
      { nodeId: 'n1', role: 'reviewer', tier: 'in-process', adapter: 'claude' },
      'the retry replaced the earlier tier for the same node',
    );
    assert.equal(bundle.executionTiers?.find((e) => e.nodeId === 'n2')?.fellBackFrom, 'in-process');
    // Inside the signed payload, not beside it: re-wrapping the predicate verifies (D-36).
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F10/F4: the run's attestation holds every call, and a `no_change` failure reads back the node's
// own. `toolCallsForTask` is that filter, and it is by `taskId` — a task with no calls gets none, not
// the run-wide list, so a sibling's denial cannot appear on a node that made none. Asserted here
// (the filter) as well as through the dispatcher (the message it produces).
test('toolCallsForTask returns only the calls carrying that taskId, in call order (F4)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const runId = makeRunId('r-tasks');
    const attestor = new Attestor(runId, stubGraph, dir, { secret: 'test-secret' });
    const call = (taskId: string, toolId: string) => ({
      toolId:         makeToolId(toolId),
      agentId:        makeAgentId('a1'),
      runId,
      taskId:         makeTaskId(taskId),
      input:          { path: 'x' },
      result:         { stdout: '', stderr: '', exitCode: 0, duration: 1, metadata: {} },
      invokedAt:      new Date(0),
      durationMs:     1,
      policyDecision: { verdict: 'Allow' as const },
    });
    await attestor.record(call('n1', 'fs.write'));
    await attestor.record(call('n2', 'grep'));
    await attestor.record(call('n1', 'fs.read'));

    // Three calls are on the record; each task sees only its own, in call order.
    assert.deepEqual(attestor.toolCallsForTask(makeTaskId('n1')).map((c) => String(c.toolId)), ['fs.write', 'fs.read']);
    assert.deepEqual(attestor.toolCallsForTask(makeTaskId('n2')).map((c) => String(c.toolId)), ['grep']);
    assert.deepEqual(attestor.toolCallsForTask(makeTaskId('n3')), [], 'a task with no calls gets none, not the run-wide list');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ORACLE (WP-3.0c, D-45; the F7 window). Two additions to the record the 3.0c work introduces: an
// attributed change — a reader's turn charged to the writer that held the lock across it — which must
// be in the signed payload with the rest; and the `tier` field, which is optional. What the recorder
// does with a surface handed to it without a `tier` is only the writer's half of compatibility. The
// claim itself — that a bundle a real 0.3.1 build wrote still verifies under this reader — rests on
// the committed fixture in intoto.test.ts, not on a bundle this code mints.

test('an attributed change flows into the signed bundle; unrecorded, the field is omitted (WP-3.0c)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const attestor = new Attestor(makeRunId('r-3c-attr'), stubGraph, dir, { secret: 'test-secret' });
    attestor.recordAttribution({
      nodeId: 'reader-1' as never, attributedTo: 'writer-2' as never, diffSha256: 'd'.repeat(64),
      fromTree: 'a'.repeat(40), toTree: 'b'.repeat(40), writerGateTree: 'c'.repeat(40),
    });

    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });

    assert.deepEqual(
      bundle.attributedChanges,
      [{ nodeId: 'reader-1', attributedTo: 'writer-2', diffSha256: 'd'.repeat(64),
         fromTree: 'a'.repeat(40), toTree: 'b'.repeat(40), writerGateTree: 'c'.repeat(40) }],
      'the attribution is in the bundle, naming the reader, the writer and the three tree ids (N6)',
    );
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true, 'inside the signed payload, not beside it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const bare = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const attestor = new Attestor(makeRunId('r-3c-bare'), stubGraph, bare, { secret: 'test-secret' });
    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });
    assert.equal('attributedChanges' in bundle, false, 'unrecorded, not recorded-as-empty');
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('a surface recorded without a `tier` is written that way and the bundle signs (WP-3.0c)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const attestor = new Attestor(makeRunId('r-3c-old'), stubGraph, dir, { secret: 'test-secret' });
    // Three digests and the argv, no tier — the shape a 0.3.1 build recorded.
    // The check is minted, not fixture-backed: no offline scripted path in the v0.3.1 tree records
    // `modelSurfaces` (measured — the `inprocess-demo` bundle and every bundle in that run carry no
    // such field), so there is no 0.3.1 bundle to run this against.
    attestor.recordModelSurface({
      role: 'analyst', taskId: 't1' as never, turn: 1,
      systemPromptSha256: 'f'.repeat(64), promptSha256: 'e'.repeat(64),
      toolCatalog: '', outputSha256: 'd'.repeat(64), argv: ['--print', '-p', '--', '<prompt: 4 bytes, sha256 ' + 'a'.repeat(64) + '>'],
    });

    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });

    const surface = bundle.modelSurfaces?.[0];
    assert.equal(surface?.role, 'analyst');
    assert.equal('tier' in (surface ?? {}), false, 'absent, not present-and-undefined — the recorder does not fill one in');
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true, 'and it verifies: an untiered surface is signable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
