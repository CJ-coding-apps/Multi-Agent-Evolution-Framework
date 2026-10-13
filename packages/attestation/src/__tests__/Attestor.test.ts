import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SlsaBuilder, SlsaInvocation } from '@maf/types';
import { makeRunId } from '@maf/types';
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
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true, 'and the bundle still signs and verifies');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
