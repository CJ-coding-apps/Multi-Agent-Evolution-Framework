import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ToolContext, ToolCallRecord, AttestorHandle, ApprovalAsk, ApprovalOutcome, PolicyEngineHandle,
} from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyLoader } from '@maf/policy-engine';
import type { PolicyEngine } from '@maf/policy-engine';
import { PatchApplyTool } from '@maf/tools';
import { executeToolGated } from '../index.js';

// ORACLE: 0.5.1 — the files a diff writes are the files `git apply` names, and the shipped rules
// are asked about exactly those names.
//
// Asserted against the policy file the repository ships, loaded the way a run loads it, through the
// real gate. The 0.5.0 parser cut the header at the first TAB, so `+++ b/Cargo.lock<TAB>2026-…`
// declared the timestamped name and `protect-lock-files` missed it; it also read `Index:` names GNU
// patch honours and git does not. `patch.apply` now reads no header of its own: it asks git
// (`--numstat -z`) which files the diff names and applies the same bytes with the same `-p`, so a
// header form git does not follow is a refusal before policy, not a declaration of the parser's
// choosing. The full spelling-by-spelling table is in `patch-conformance.test.ts`.

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

test('an Index:-only diff is refused before policy: git follows no `Index:` line', async () => {
  // The 0.5.0 parser read `Index:` as a name GNU patch would honour, so policy was asked about a
  // string git never writes and the call could be allowed. Now git names no file for this diff, and
  // a diff whose targets cannot be declared is not an allowed one.
  const diff = 'Index: .env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n';
  const { decision } = await refused(diff, 0);
  assert.equal(decision['verdict'], 'Deny');
  assert.equal(decision['ruleId'], 'builtin:declaration');
  await assert.rejects(stat(path.join(projectRoot, '.env')), { code: 'ENOENT' });
});

test('a context diff is refused before policy: git applies unified diffs only', async () => {
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
  assert.equal(decision['ruleId'], 'builtin:declaration', 'the `***`/`---` pair names no file git writes');
  await assert.rejects(stat(path.join(projectRoot, '.env')), { code: 'ENOENT' });
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

test('a write through a link to Cargo.lock is refused at declaration, and no approver is asked (L3)', async () => {
  // The link resolves to a file `protect-lock-files` escalates on, but the policy would be shown the
  // link's own name, which no rule matches. git rewrites a link in place, so an Allow on `link` would
  // land in `Cargo.lock`. The declaration refuses the write before policy is consulted at all — the
  // refusal and its `builtin:declaration` record are the whole outcome, and no human is asked.
  const lock = path.join(projectRoot, 'Cargo.lock');
  const link = path.join(projectRoot, 'link');
  await writeFile(lock, 'lock1\n', 'utf8');
  await symlink('Cargo.lock', link);
  try {
    const asked: ApprovalAsk[] = [];
    const evaluated: string[] = [];
    const policy: PolicyEngineHandle = {
      async evaluate(toolId, input, ctx, declaredPaths) {
        evaluated.push(String(toolId));
        return engine.evaluate(toolId, input, ctx, declaredPaths);
      },
    };
    const approvalGate = {
      async decide(ask: ApprovalAsk): Promise<ApprovalOutcome> {
        asked.push(ask);
        return {
          approved: true, status: 'Approved',
          requestId: ask.request.id, requestHash: '', reason: 'approved by the test',
        };
      },
    };
    const attestor = new SpyAttestor();
    const diff = '--- a/link\n+++ b/link\n@@ -1 +1 @@\n-lock1\n+lock2\n';
    await assert.rejects(
      () => executeToolGated(
        new PatchApplyTool(), { diff }, ctxIn(attestor), { policy, attestor, approvalGate },
      ),
      /Policy violation/,
    );
    const record = attestor.records[0]!;
    const decision = record.policyDecision as unknown as Record<string, unknown>;
    assert.equal(decision['verdict'], 'Deny');
    assert.equal(decision['ruleId'], 'builtin:declaration');
    assert.match(String(decision['reason']), /"link", which is a symbolic link/);
    assert.equal(record.result.metadata?.['refused'], true, 'the call is recorded as a refusal');
    assert.deepEqual(evaluated, [], 'the policy was never asked');
    assert.deepEqual(asked, [], 'no approver was asked');
    assert.equal(await readFile(lock, 'utf8'), 'lock1\n', 'the lock file is unchanged');
    assert.equal(await readlink(link), 'Cargo.lock', 'the link still points where it did');
  } finally {
    await rm(link, { force: true });
    await rm(lock, { force: true });
  }
});
