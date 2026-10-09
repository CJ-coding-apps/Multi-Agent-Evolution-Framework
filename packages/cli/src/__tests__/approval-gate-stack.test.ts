import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRunId } from '@maf/types';
import type { AttestationBundle } from '@maf/types';
import { mintHarnessConfig } from '@maf/harness-config';
import { ScriptedAdapter } from '@maf/eval-harness';
import { buildRunStack } from '../wiring.js';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { needsLcm } from './runFixture.js';

// ORACLE: WP-2.2 integration (rule 7, D-02) — the approval gate reaches an in-process tool call
// through the stack goldens, evolve and the demo share: buildRunStack builds one gate, dispatchTask
// hands it to the dispatcher, the dispatcher to the loop, the loop to executeToolGated. goldens and
// evolve build it headless, so an escalated call is refused, recorded as pending and attested.

const PROMPT = 'Fix sum.js.';
const FIXED = 'module.exports = (a, b) => a + b;\n';

test('a headless stack refuses an escalated call, leaves a pending record, attests it, and the loop goes on', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-approval-stack-'));
  try {
    const repo = await createDemoFixture(root);
    const mafDir = path.join(root, 'state');
    const policyPath = path.join(root, 'policy.yaml');
    await writeFile(policyPath, JSON.stringify({ rules: [
      { id: 'lock-files-need-a-human', description: 'lock files', priority: 95,
        predicate: { toolId: 'fs.write', pathGlob: '**/*.lock' }, action: { kind: 'Escalate', requiresApproval: true } },
    ] }), 'utf8');
    const harness = mintHarnessConfig({
      id: 'approval-stack', processorBundles: [],
      roleSet: { version: 1, defaultRole: 'coder', roles: [{
        role: 'coder', systemPrompt: 'fix it', allowedTools: ['fs.read', 'fs.write'], execution: 'in-process',
      }] },
    });
    const adapter = new ScriptedAdapter([{ prompt: PROMPT, final: 'done', steps: [
      { tool: 'fs.write', input: { path: 'yarn.lock', content: 'pinned\n' } },
      { tool: 'fs.write', input: { path: 'sum.js', content: FIXED } },
    ] }]);
    const runId = makeRunId(crypto.randomUUID());
    const stack = await buildRunStack({ cwd: repo, mafDir, policyPath, adapter, runId, harnessSha: harness.sha, headless: true });
    try {
      await stack.dispatchTask(harness, 'coder', PROMPT, repo, 60_000, 0);
      await stack.attestor.bundle({ id: 'test', modelVersion: 'scripted' },
        { configSource: { uri: 'test', digest: { sha256: harness.sha } }, parameters: {}, environment: {} },
        [], { status: 'Succeeded', unscheduled: [] });
    } finally {
      stack.close();
    }

    await assert.rejects(access(path.join(repo, 'yarn.lock')), 'the refused call never ran');
    assert.equal(await readFile(path.join(repo, 'sum.js'), 'utf8'), FIXED, 'the loop went on to the next call');
    const pendingDir = path.join(mafDir, 'approvals', 'pending');
    const [pendingName] = await readdir(pendingDir);
    assert.ok(pendingName, 'a pending record names the refused request');
    const pending = JSON.parse(await readFile(path.join(pendingDir, pendingName), 'utf8')) as { reason: string };
    assert.match(pending.reason, /MAF_HEADLESS=1/, 'headless because the stack says so, not because stdin happens not to be a terminal');

    const statement = JSON.parse(await readFile(path.join(mafDir, 'attestations', `${runId}.bundle.json`), 'utf8')) as { predicate: AttestationBundle };
    assert.deepEqual(statement.predicate.approvals.map((a) => [a.decision.status, a.decision.reviewer]), [['Rejected', 'headless']]);
    assert.equal(statement.predicate.approvals[0]?.requestId, pendingName.replace(/\.json$/, ''));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
