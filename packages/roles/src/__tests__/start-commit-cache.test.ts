import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, AdapterCapabilities, AdapterInvokeResult, DagNode, SecurityReviewResult,
} from '@maf/types';
import { TransportError, makeNodeId, makeRunId, makeToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { SecurityReviewGate } from '@maf/git-ops';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';

// ORACLE (D-06; audit P0 #3): the security gate's baseline commit is captured once per node and
// reused by a retry. Re-capturing it per attempt meant a coder that committed on a failed attempt
// handed attempt 2 a baseline that already contained its change: the diff came back empty and the
// gate called an unreviewed change reviewed. The baseline is forgotten when the node ends.

const execFileAsync = promisify(execFile);

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

/** A CLI agent whose every invocation is scripted: what it does to the tree, and how it ends. */
class ScriptedCliAdapter implements CliAdapter {
  readonly name = 'scripted-cli';
  readonly script: Array<() => Promise<void>> = [];
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    const step = this.script.shift();
    if (step) await step();
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

function coderNode(id: string): DagNode {
  return {
    id: makeNodeId(id), label: 'implement the change', agentRole: defineRoleName('coder'), dependencies: [],
    retryPolicy: { maxAttempts: 2, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {},
    metadata: { taskDescription: 'implement the change' },
  };
}

interface Fixture {
  dispatcher: RoleDispatcher;
  adapter: ScriptedCliAdapter;
  workDir: string;
  /** Every diff the security gate was asked to review, in order. */
  reviewed: string[];
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-baseline-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await commitAll(workDir, 'base');

  const reviewed: string[] = [];
  const adapter = new ScriptedCliAdapter();
  // A writer by its tools as well as by its name: D-07 keys the gate on holding a write tool,
  // and this fixture has to reach the gate whichever of the two the dispatcher checks.
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: defineRoleName('coder'),
    roles: [{
      role: defineRoleName('coder'),
      systemPrompt: 'code',
      allowedTools: [makeToolId('fs.write'), makeToolId('git.commit')],
      execution: 'cli',
    }],
  }, workDir);

  const dispatcher = new RoleDispatcher({
    adapter,
    baseTools: createDefaultRegistry() as ToolRegistry,
    roles,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: {
      record: async () => {},
      recordSecurityFindings: (_nodeId: string, _r: SecurityReviewResult) => {},
    } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: { append: async () => {} } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    securityGate: {
      reviewDiff: async (diff: string) => {
        reviewed.push(diff);
        return { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
    cwd: workDir,
    sessionId: 's1',
    runId: makeRunId('run-baseline'),
    harness: { processorBundles: [] } as unknown as HarnessConfig,
  });

  return {
    dispatcher, adapter, workDir, reviewed,
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd });
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message], { cwd });
}

/** What Claude Code commonly does: change a file and commit it. */
function changeAndCommit(workDir: string, content: string): () => Promise<void> {
  return async () => {
    await writeFile(path.join(workDir, 'hello.txt'), content, 'utf8');
    await commitAll(workDir, 'agent committed');
  };
}

test('a retried coder node is reviewed against the commit its first attempt started from', async () => {
  const fx = await makeFixture();
  try {
    fx.adapter.script.push(
      // Attempt 1 commits its change, then the transport drops before the gate is reached.
      async () => {
        await changeAndCommit(fx.workDir, 'hello, changed by attempt 1')();
        throw new TransportError('the backend closed the connection');
      },
      // Attempt 2 (the retry) changes nothing further and succeeds.
      async () => {},
    );

    await assert.rejects(() => fx.dispatcher.runNode(coderNode('c1')), TransportError);
    assert.deepEqual(fx.reviewed, [], 'attempt 1 failed before the gate');

    await fx.dispatcher.runNode(coderNode('c1'));
    assert.equal(fx.reviewed.length, 1,
      'a baseline re-captured on the retry would include attempt 1\'s commit, diff clean and skip the gate');
    assert.match(fx.reviewed[0] ?? '', /changed by attempt 1/, 'the retry reviews what the failed attempt committed');
  } finally {
    await fx.cleanup();
  }
});

test('a node that has ended starts its next run from the tree as it is then', async () => {
  const fx = await makeFixture();
  try {
    fx.adapter.script.push(changeAndCommit(fx.workDir, 'hello, changed by run 1'), async () => {});

    await fx.dispatcher.runNode(coderNode('c1'));
    assert.equal(fx.reviewed.length, 1);

    fx.dispatcher.endNode(makeNodeId('c1'));

    // Nothing changes on this run. A baseline held past the node's end would still diff
    // against the original commit and send run 1's change to the gate a second time.
    await fx.dispatcher.runNode(coderNode('c1'));
    assert.equal(fx.reviewed.length, 1, 'the ended node\'s baseline must not be reused');
  } finally {
    await fx.cleanup();
  }
});

test('each node captures its own baseline', async () => {
  const fx = await makeFixture();
  try {
    fx.adapter.script.push(changeAndCommit(fx.workDir, 'hello, changed by c1'), async () => {});

    await fx.dispatcher.runNode(coderNode('c1'));
    assert.equal(fx.reviewed.length, 1);

    // c2 starts after c1 committed, so c1's change is not c2's to answer for.
    await fx.dispatcher.runNode(coderNode('c2'));
    assert.equal(fx.reviewed.length, 1, 'c2 must not inherit c1\'s baseline');
  } finally {
    await fx.cleanup();
  }
});
