import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson as fromTypes } from '@maf/types';
import { canonicalJson, mintHarnessConfig } from '../index.js';

// ORACLE: D-13 (part 2) — the canonicalizer moved to @maf/types so the attestation can sign
// with it without a new package edge. Moving it must not move a single harness id.

test('harness-config re-exports the @maf/types canonicalizer, not a copy', () => {
  assert.equal(canonicalJson, fromTypes);
});

test('a harness sha minted before the move is minted identically after it', () => {
  const cfg = mintHarnessConfig({
    id: 'pinned',
    roleSet: {
      version: 1,
      defaultRole: 'coder',
      roles: [{ role: 'coder', systemPrompt: 'write code', allowedTools: ['fs.read', 'fs.write'] }],
    },
    processorBundles: [{ name: 'secret-redact', config: { b: 1, a: [2, { d: 1, c: 2 }] } }],
  });
  // Computed by the 0.2.1 `canonicalize.ts`, before canonicalJson left it.
  assert.equal(cfg.sha, '2c5e9989e915de88375233508f5b114675a3adcb09fbd1f4f7d775ff281c77b1');
});
