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
    const attestor = new Attestor(runId, stubGraph, dir, 'test-secret');

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
    const bundle = await attestor.bundle(builder, invocation, []);

    assert.equal(bundle.securityFindings?.length, 1);
    assert.equal(bundle.securityFindings?.[0]?.nodeId, 'node-1');
    assert.equal(bundle.securityFindings?.[0]?.result.passed, false);
    assert.ok(bundle.signature, 'bundle must be signed');
    assert.ok(Attestor.verify(bundle, 'test-secret'), 'signature verifies against same secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundle without recordSecurityFindings has empty securityFindings list', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-'));
  try {
    const runId = makeRunId('r-2');
    const attestor = new Attestor(runId, stubGraph, dir, 'test-secret');
    const bundle = await attestor.bundle(
      { id: 'b@1', modelVersion: 'v' },
      { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
      [],
    );
    assert.ok(Array.isArray(bundle.securityFindings));
    assert.equal(bundle.securityFindings?.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
