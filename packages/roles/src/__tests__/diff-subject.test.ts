import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CliAdapter, AdapterCapabilities, AdapterInvokeResult, DagNode } from '@maf/types';
import { makeNodeId, makeRunId, makeToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { SecurityReviewGate } from '@maf/git-ops';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';

// ORACLE: D-13 (part 2) + audit P1 "`diffHashes` always empty (`recordDiffHash` has no
// production caller)". The diff the post-task gate reads is the writer's change; its hash is a
// subject of the run's in-toto statement, so the statement names what the run produced.

const execFileAsync = promisify(execFile);
const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

class EditingAdapter implements CliAdapter {
  readonly name = 'editing';
  constructor(private readonly edit: () => Promise<void>) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    await this.edit();
    return { success: true, output: 'done', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

const NODE: DagNode = {
  id: makeNodeId('c1'), label: 'change hello', agentRole: defineRoleName('coder'), dependencies: [],
  retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
  timeoutMs: 30_000, inputs: {}, outputs: {}, metadata: { taskDescription: 'change hello' },
};

async function withRun(
  opts: { edit: (dir: string) => Promise<void>; gate: boolean },
  body: (ctx: { attestor: Attestor; reviewed: string[]; dispatcher: RoleDispatcher }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-diff-subject-'));
  try {
    await writeFile(path.join(dir, 'hello.txt'), 'hello', 'utf8');
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });

    const attestor = new Attestor(makeRunId('run-subject'), { addNode: async () => 'n' } as unknown as MemoryGraph,
      path.join(dir, '.maf', 'attestations'), { secret: 's3cret' });
    const reviewed: string[] = [];
    const config = {
      adapter: new EditingAdapter(() => opts.edit(dir)),
      baseTools: createDefaultRegistry() as ToolRegistry,
      roles: RoleRegistry.fromSet({
        version: 1,
        defaultRole: defineRoleName('coder'),
        roles: [{
          role: defineRoleName('coder'), systemPrompt: 'work',
          allowedTools: ['fs.read', 'fs.write'].map((id) => makeToolId(id)), execution: 'cli',
        }],
      }, dir),
      injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
      policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
      attestor,
      graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
      transcript: { append: async () => {} } as unknown as TranscriptLogger,
      lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
      cwd: dir,
      sessionId: 's1',
      runId: makeRunId('run-subject'),
      harness: { processorBundles: [] } as unknown as HarnessConfig,
      // A cli-tier writer runs only with the run's consent once D-01 lands; inert before.
      allowUngoverned: true,
      stderr: { write: () => true },
      ...(opts.gate ? {
        securityGate: {
          reviewDiff: async (diff: string) => { reviewed.push(diff); return { findings: [], summary: 'clean', passed: true }; },
        } as unknown as SecurityReviewGate,
      } : {}),
    };
    await body({ attestor, reviewed, dispatcher: new RoleDispatcher(config) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const finalize = (attestor: Attestor) => attestor.finalize(
  { id: 'b', modelVersion: 'v' },
  { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
  [],
  { status: 'Succeeded', unscheduled: [] },
);

test('the diff the security gate reviewed is a subject of the run statement, by node', async () => {
  await withRun({ gate: true, edit: (dir) => writeFile(path.join(dir, 'hello.txt'), 'hello, changed', 'utf8') },
    async ({ attestor, reviewed, dispatcher }) => {
      await dispatcher.runNode(NODE);
      assert.equal(reviewed.length, 1);
      const signed = await finalize(attestor);
      assert.deepEqual(signed.subject, [{ name: 'c1.diff', digest: { sha256: sha256(reviewed[0] ?? '') } }],
        'the subject digest is the hash of exactly the diff the gate read');
      assert.equal(Attestor.verify(signed, { secret: 's3cret' }), true);
    });
});

test('a writer change is a subject even when no security gate is configured', async () => {
  await withRun({ gate: false, edit: (dir) => writeFile(path.join(dir, 'new.txt'), 'new', 'utf8') },
    async ({ attestor, dispatcher }) => {
      await dispatcher.runNode(NODE);
      const signed = await finalize(attestor);
      assert.deepEqual(signed.subject.map((s) => s.name), ['c1.diff']);
    });
});

test('a writer that changed nothing adds no subject', async () => {
  await withRun({ gate: true, edit: async () => {} }, async ({ attestor, reviewed, dispatcher }) => {
    await dispatcher.runNode(NODE);
    assert.deepEqual(reviewed, []);
    assert.deepEqual((await finalize(attestor)).subject, []);
  });
});
