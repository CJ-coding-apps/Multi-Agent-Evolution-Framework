import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolCallRecord, AttestorHandle } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyLoader } from '@maf/policy-engine';
import type { PolicyEngine } from '@maf/policy-engine';
import { PatchApplyTool } from '@maf/tools';
import { executeToolGated } from '../index.js';

// ORACLE: 0.5.1 — a diff header `patch` itself accepts cannot name a file no path rule sees.
//
// Asserted against the policy file the repository ships, loaded the way a run loads it, for every
// header spelling GNU `patch` reads. Before the fix, `+++ b/Cargo.lock<TAB>2026-…` declared the
// timestamped name (so `protect-lock-files` missed) and an `Index:`-only diff declared nothing at all
// (so `deny-env-files` missed), and `patch` wrote the file either way.

// dist/__tests__ → package → packages → repository root.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SHIPPED_POLICY = path.join(REPO_ROOT, '.maf', 'policy.yaml');
const STAMP = '\t2026-01-01 00:00:00.000000000 +0000';

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

let projectRoot = '';
let engine: PolicyEngine;

before(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'maf-051-shipped-policy-'));
  await mkdir(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
  await mkdir(path.join(projectRoot, '.maf'), { recursive: true });
  engine = await PolicyLoader.loadEngine(SHIPPED_POLICY, {} as never);
});

after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function ctxIn(attestor: AttestorHandle): ToolContext {
  return {
    cwd: projectRoot, projectRoot,
    runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
    sessionId: 's1', agentRole: 'coder',
    policy: engine, attestor,
  };
}

async function refused(diff: string, strip: number | undefined): Promise<{ attestor: SpyAttestor; decision: Record<string, unknown> }> {
  const attestor = new SpyAttestor();
  const input = strip === undefined ? { diff } : { diff, strip };
  await assert.rejects(
    () => executeToolGated(new PatchApplyTool(), input, ctxIn(attestor), { policy: engine, attestor }),
    /Policy violation/,
  );
  assert.equal(attestor.records.length, 1, 'the refusal is attested before it is thrown');
  const decision = attestor.records[0]!.policyDecision as unknown as Record<string, unknown>;
  assert.equal(attestor.records[0]!.result.metadata?.['refused'], true, 'nothing ran');
  return { attestor, decision };
}

test('a timestamped +++ header reaches protect-lock-files', async () => {
  const diff = [
    `--- a/Cargo.lock${STAMP}`,
    `+++ b/Cargo.lock${STAMP}`,
    '@@ -1 +1 @@', '-a', '+b', '',
  ].join('\n');
  const { decision } = await refused(diff, undefined);
  assert.equal(decision['verdict'], 'Escalate');
  assert.equal((decision['approvalRequest'] as { policyRuleId?: string }).policyRuleId, 'protect-lock-files');
  await assert.rejects(stat(path.join(projectRoot, 'Cargo.lock')), { code: 'ENOENT' });
});

test('a timestamp-less TAB suffix reaches the same rule', async () => {
  const diff = '--- a/Cargo.lock\tlatest\n+++ b/Cargo.lock\tlatest\n@@ -1 +1 @@\n-a\n+b\n';
  const { decision } = await refused(diff, undefined);
  assert.equal(decision['verdict'], 'Escalate');
});

test('an Index:-only diff reaches deny-env-files for .env', async () => {
  // `-p0` leaves a bare `Index:` name intact, which is the reported call.
  const diff = 'Index: .env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n';
  const { decision } = await refused(diff, 0);
  assert.equal(decision['verdict'], 'Deny');
  assert.equal(decision['ruleId'], 'deny-env-files');
  await assert.rejects(stat(path.join(projectRoot, '.env')), { code: 'ENOENT' });
});

test('a context diff reaches deny-env-files through its *** / --- pair', async () => {
  const diff = [
    `*** old/.env${STAMP}`,
    `--- new/.env${STAMP}`,
    '***************',
    '*** 1 ****',
    '- SAFE=1',
    '--- 1 ----',
    '+ LEAK=1',
    '',
  ].join('\n');
  const { decision } = await refused(diff, undefined);
  assert.equal(decision['verdict'], 'Deny');
  assert.equal(decision['ruleId'], 'deny-env-files');
});

test('a diff --git header with a TAB reaches deny-env-files for .env', async () => {
  const diff = `diff --git a/.env b/.env${STAMP}\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n`;
  const { decision } = await refused(diff, undefined);
  assert.equal(decision['verdict'], 'Deny');
  assert.equal(decision['ruleId'], 'deny-env-files');
  await assert.rejects(stat(path.join(projectRoot, '.env')), { code: 'ENOENT' });
});

test('a diff whose headers name no file is refused before policy, as builtin:declaration', async () => {
  // Policy was never asked, so no rule could have covered the call — and it is recorded as the
  // refusal it is, not as a failed call under an Allow the policy never gave.
  const attestor = new SpyAttestor();
  await assert.rejects(
    () => executeToolGated(new PatchApplyTool(), { diff: 'just some random text' }, ctxIn(attestor), { policy: engine, attestor }),
    /Policy violation/,
  );
  const record = attestor.records[0]!;
  const decision = record.policyDecision as unknown as Record<string, unknown>;
  assert.equal(decision['verdict'], 'Deny');
  assert.equal(decision['ruleId'], 'builtin:declaration');
  assert.equal(record.result.metadata?.['ruleId'], 'builtin:declaration');
  assert.equal(record.result.metadata?.['refused'], true);
});
