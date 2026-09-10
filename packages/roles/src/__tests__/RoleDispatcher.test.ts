import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult,
  TurnMessage, AssistantTurn, DagNode, PolicyDecision, ToolContext, ToolInput, ToolResult,
} from '@maf/types';
import { makeNodeId, makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry } from '../RoleRegistry.js';

// ORACLE: HARNESSX_INTEGRATION_PLAN.md §4.x — in-process dispatch, fallback, gating parity.

// ─── stubs (shell-seam doubles; core under test is RoleDispatcher) ───────────

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

class StubTurnAdapter implements TurnAdapter {
  readonly name = 'stub';
  invoked = 0;
  turnsToServe: AssistantTurn[] = [];
  histories: TurnMessage[][] = [];
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    this.invoked++;
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(history: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    this.histories.push(history);
    const next = this.turnsToServe.shift();
    if (!next) return { text: 'final', toolCalls: [] };
    return next;
  }
}

class CliOnlyAdapter implements CliAdapter {
  readonly name = 'cli-only';
  invoked = 0;
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: false }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    this.invoked++;
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

function makeTranscriptRecorder() {
  const entries: Array<{ role: string; content: string; metadata: Record<string, unknown> }> = [];
  const stub: Pick<TranscriptLogger, 'append'> = {
    append: async (role, content, metadata = {}) => { entries.push({ role, content, metadata }); },
  };
  return { entries, stub: stub as unknown as TranscriptLogger };
}

function makePolicy(handler: (toolId: string, input: ToolInput) => PolicyDecision) {
  const calls: Array<{ toolId: string; input: ToolInput }> = [];
  return {
    calls,
    stub: {
      evaluate: async (toolId: unknown, input: ToolInput, _ctx: ToolContext) => {
        calls.push({ toolId: String(toolId), input });
        return handler(String(toolId), input);
      },
    } as unknown as PolicyEngine,
  };
}

function makeAttestor() {
  const records: Array<{ toolId: string; result: ToolResult }> = [];
  return {
    records,
    stub: { record: async (c: { toolId: string; result: ToolResult }) => { records.push(c); } } as unknown as Attestor,
  };
}

function makeNode(role: string, description = 'do the thing'): DagNode {
  return {
    id: makeNodeId('n1'), label: description, agentRole: role, dependencies: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {},
    metadata: { taskDescription: description },
  };
}

interface Fixture {
  dispatcher: RoleDispatcher;
  adapter: StubTurnAdapter | CliOnlyAdapter;
  transcript: ReturnType<typeof makeTranscriptRecorder>;
  policy: ReturnType<typeof makePolicy>;
  attestor: ReturnType<typeof makeAttestor>;
  workDir: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(opts: {
  roleExecution: 'cli' | 'in-process';
  adapter: StubTurnAdapter | CliOnlyAdapter;
  policyHandler: (toolId: string, input: ToolInput) => PolicyDecision;
  bundles?: HarnessConfig;
}): Promise<Fixture> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-dispatch-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello-world', 'utf8');
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: 'analyst',
    roles: [{
      role: 'analyst',
      systemPrompt: 'analyze',
      allowedTools: [makeToolId('fs.read')],
      execution: opts.roleExecution,
      maxToolIterations: 4,
    }],
  }, workDir);
  const transcript = makeTranscriptRecorder();
  const policy = makePolicy(opts.policyHandler);
  const attestor = makeAttestor();
  const harness = opts.bundles ?? mintHarnessConfig({
    id: 'test',
    roleSet: { version: 1, defaultRole: 'analyst', roles: [{ role: 'analyst', allowedTools: ['fs.read'], execution: opts.roleExecution }] },
    processorBundles: [{ name: 'transcript' }, { name: 'policy-audit' }],
  });
  const dispatcher = new RoleDispatcher({
    adapter: opts.adapter,
    baseTools: createDefaultRegistry(),
    roles,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: policy.stub,
    attestor: attestor.stub,
    graph: {} as MemoryGraph,
    transcript: transcript.stub,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    cwd: workDir,
    sessionId: 's1',
    runId: makeRunId('run-1'),
    harness,
  });
  return {
    dispatcher, adapter: opts.adapter, transcript, policy, attestor, workDir,
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

const ALLOW = (): PolicyDecision => ({ verdict: 'Allow' });

// ─── tests ─────────────────────────────────────────────────────────────────

test('in-process role: model tool call executes through the gate and reaches history', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'reading', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'done reading', toolCalls: [] },
  ];
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode('analyst'));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.match(output.value, /done reading/);

    // tool executed: history turn 2 contains the tool result with file contents
    const turn2 = adapter.histories[1] ?? [];
    const toolMsg = turn2.find((m) => m.kind === 'tool');
    assert.ok(toolMsg && toolMsg.kind === 'tool');
    assert.match(toolMsg.content, /hello-world/);
    // policy saw exactly one evaluation for fs.read
    assert.deepEqual(f.policy.calls.map((c) => c.toolId), ['fs.read']);
    // attestation recorded the gated execution
    assert.equal(f.attestor.records.length, 1);
    // adapter's legacy invoke was NOT used
    assert.equal(adapter.invoked, 0);
  } finally {
    await f.cleanup();
  }
});

test('in-process role: policy Deny prevents execution and feeds the model an error message', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'try', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.read', input: { path: 'hello.txt' } }] },
    { text: 'blocked, giving up', toolCalls: [] },
  ];
  const f = await makeFixture({
    roleExecution: 'in-process', adapter,
    policyHandler: () => ({ verdict: 'Deny', reason: 'test denies all' }),
  });
  try {
    await f.dispatcher.runNode(makeNode('analyst'));
    const turn2 = adapter.histories[1] ?? [];
    const toolMsg = turn2.find((m) => m.kind === 'tool');
    assert.ok(toolMsg && toolMsg.kind === 'tool' && toolMsg.isError);
    assert.match(toolMsg.content, /policy Deny/);
    assert.equal(f.attestor.records.length, 0, 'nothing executes against Deny');
  } finally {
    await f.cleanup();
  }
});

test('in-process role: tool outside the allowlist is rejected before policy', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = [
    { text: 'try', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.write', input: { path: 'x', content: 'y' } }] },
    { text: 'gave up', toolCalls: [] },
  ];
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    await f.dispatcher.runNode(makeNode('analyst'));
    const turn2 = adapter.histories[1] ?? [];
    const toolMsg = turn2.find((m) => m.kind === 'tool');
    assert.ok(toolMsg && toolMsg.kind === 'tool' && toolMsg.isError);
    assert.match(toolMsg.content, /allowlist/);
    assert.equal(f.policy.calls.length, 0, 'not found in allowlist — policy never consulted');
  } finally {
    await f.cleanup();
  }
});

test('fallback: in-process role on a CLI-only adapter uses legacy dispatch with a warning', async () => {
  const adapter = new CliOnlyAdapter();
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode('analyst'));
    const output = out['output'];
    if (!output || output.kind !== 'string') assert.fail('expected string output');
    assert.equal(output.value, 'CLI-PATH');
    assert.equal(adapter.invoked, 1);
    const warn = f.transcript.entries.find((e) => e.content.includes('falling back to CLI dispatch'));
    assert.ok(warn, 'fallback is surfaced in the transcript');
  } finally {
    await f.cleanup();
  }
});

test('cli role on a TurnAdapter still uses the legacy single-invocation path', async () => {
  const adapter = new StubTurnAdapter();
  const f = await makeFixture({ roleExecution: 'cli', adapter, policyHandler: ALLOW });
  try {
    await f.dispatcher.runNode(makeNode('analyst'));
    assert.equal(adapter.invoked, 1);
    assert.equal(adapter.histories.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('in-process loop: maxToolIterations caps runaway tool chains', async () => {
  const adapter = new StubTurnAdapter();
  adapter.turnsToServe = Array.from({ length: 20 }, (_, i) => ({
    text: `step ${i}`,
    toolCalls: [{ toolUseId: `u${i}`, toolName: 'fs.read', input: { path: 'hello.txt' } }],
  }));
  const f = await makeFixture({ roleExecution: 'in-process', adapter, policyHandler: ALLOW });
  try {
    const out = await f.dispatcher.runNode(makeNode('analyst'));
    assert.ok(out['output'] !== undefined, 'budget_exhausted returns without throwing');
    assert.equal(f.policy.calls.length, 4, 'maxToolIterations=4 from role config');
  } finally {
    await f.cleanup();
  }
});
