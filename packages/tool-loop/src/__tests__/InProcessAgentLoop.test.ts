import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRunId, makeTaskId, makeToolId,
} from '@maf/types';
import type {
  TurnAdapter, TurnMessage, AssistantTurn, AdapterInvokeOptions, AdapterInvokeResult,
  AdapterCapabilities, ToolPlugin, ToolId, ToolContext, ToolResult, ToolCallRecord,
  PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import {
  ProcessorPipeline, StaticProcessorRegistry, Processor, ContractViolation,
} from '@maf/processors';
import type { HarnessEvent, ToolResultEvent } from '@maf/processors';
import { InProcessAgentLoop, executeToolGated } from '../index.js';

// ORACLE: HARNESSX_INTEGRATION_PLAN.md §4.1 + audit fixes M1/L1/L3.

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

/** Adapter that replays a fixed script of assistant turns. */
class ScriptedAdapter implements TurnAdapter {
  readonly name = 'scripted';
  constructor(private readonly turns: AssistantTurn[]) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    return { success: true, output: '', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield ''; }
  async sendTurn(_h: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    return this.turns.shift() ?? { text: 'final', toolCalls: [] };
  }
}

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

function echoTool(id: string, out: string): ToolPlugin {
  return {
    id: makeToolId(id) as ToolId,
    name: id,
    description: `echo ${id}`,
    permissionLevel: 'read',
    async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
      return { stdout: out, stderr: '', exitCode: 0, duration: 0, metadata: {} };
    },
  };
}

const baseOpts = {
  role: 'analyst', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'do it',
  workingDir: '/tmp', projectRoot: '/tmp', sessionId: 's1',
};
const baseDeps = (adapter: TurnAdapter, attestor: AttestorHandle) => ({
  adapter, policy: ALLOW, attestor,
  runId: makeRunId('r1'), taskId: makeTaskId('t1'),
});

test('M1: tokenBudget halts the loop even when the adapter reports no tokensUsed', async () => {
  // Each turn requests a tool so the loop keeps going; no adapter token usage,
  // so enforcement relies on the estimate. A tiny budget must stop it.
  const turns: AssistantTurn[] = Array.from({ length: 50 }, () => ({
    text: 'x'.repeat(400), toolCalls: [{ toolUseId: 'u', toolName: 'echo', input: {} }],
  }));
  const loop = new InProcessAgentLoop(
    { ...baseOpts, tools: [echoTool('echo', 'ok')], maxTurns: 50, timeoutMs: 10_000, tokenBudget: 50 },
    baseDeps(new ScriptedAdapter(turns), new SpyAttestor()),
  );
  const res = await loop.run();
  assert.equal(res.outcome, 'budget_exhausted');
  assert.ok(res.steps < 50, 'loop stopped before exhausting all scripted turns');
});

test('L1: gatedExec redacts tool output before attestation and before returning', async () => {
  const attestor = new SpyAttestor();
  const ctx: ToolContext = {
    cwd: '/tmp', projectRoot: '/tmp', runId: makeRunId('r1'), taskId: makeTaskId('t1'),
    agentId: 'a1' as unknown as ToolContext['agentId'], sessionId: 's1',
    policy: ALLOW, attestor,
  };
  const tool = echoTool('leak', 'here is AKIAIOSFODNN7EXAMPLE for you');
  const result = await executeToolGated(tool, {}, ctx, { policy: ALLOW, attestor });
  assert.ok(result.stdout.includes('[REDACTED:aws-access-key]'), 'returned result is redacted');
  assert.ok(!result.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
  const recorded = attestor.records[0];
  assert.ok(recorded && !recorded.result.stdout.includes('AKIAIOSFODNN7EXAMPLE'),
    'the signed attestation record never sees the raw secret');
  // Byte-faithful: ONLY the secret substring changed; surrounding bytes preserved.
  assert.equal(recorded?.result.stdout, 'here is [REDACTED:aws-access-key] for you');
});

class Splitter extends Processor {
  override readonly name = 'splitter';
  override readonly hooks = ['after_tool'] as const;
  override async *process(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    const e = event as ToolResultEvent;
    yield e; yield e;   // split: two branches — illegal in the serving loop
  }
}

test('repair: a malformed tool_call is corrected on retry, then the loop succeeds', async () => {
  const attestor = new SpyAttestor();
  const turns: AssistantTurn[] = [
    // 1st model call: botched tool_call → no valid call parsed
    { text: 'let me call a tool', toolCalls: [], parseErrors: ['tool_call block is not valid JSON: "{...}"'] },
    // after corrective feedback: a valid call
    { text: 'retrying', toolCalls: [{ toolUseId: 'u', toolName: 'echo', input: {} }] },
    // next step: finish
  ];
  const loop = new InProcessAgentLoop(
    { ...baseOpts, tools: [echoTool('echo', 'ok')], maxTurns: 4, timeoutMs: 10_000 },
    baseDeps(new ScriptedAdapter(turns), attestor),
  );
  const res = await loop.run();
  assert.equal(res.outcome, 'completed');
  assert.equal(attestor.records.length, 1, 'the repaired tool call actually executed once');
  // the corrective feedback became part of the conversation
  const repairMsg = res.history.find((m) => m.kind === 'user' && /tool-call repair/.test(m.text));
  assert.ok(repairMsg, 'a repair feedback message was appended to the history');
});

/** Always returns a malformed tool_call (never a valid one). */
class AlwaysMalformedAdapter implements TurnAdapter {
  readonly name = 'malformed';
  calls = 0;
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    return { success: true, output: '', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield ''; }
  async sendTurn(_h: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    this.calls++;
    return { text: 'oops', toolCalls: [], parseErrors: ['tool_call block is not valid JSON: "garbage"'] };
  }
}

test('repair: exceeding the repair limit fails loudly (bounded, no infinite loop)', async () => {
  const adapter = new AlwaysMalformedAdapter();
  const loop = new InProcessAgentLoop(
    { ...baseOpts, tools: [echoTool('echo', 'ok')], maxTurns: 5, timeoutMs: 10_000, maxToolCallRepairs: 3 },
    baseDeps(adapter, new SpyAttestor()),
  );
  const res = await loop.run();
  assert.equal(res.outcome, 'failed');
  assert.match(res.error ?? '', /malformed tool_call block after 3 repair/);
  assert.equal(adapter.calls, 4, 'one primary call + exactly 3 repair retries');
});

test('L3: a processor split at a serving-loop hook fails loudly (no silent drop)', async () => {
  const reg = new StaticProcessorRegistry().register('splitter', () => new Splitter());
  const pipeline = ProcessorPipeline.build([{ name: 'splitter' }], reg, {});
  const turns: AssistantTurn[] = [
    { text: 'call it', toolCalls: [{ toolUseId: 'u', toolName: 'echo', input: {} }] },
  ];
  const loop = new InProcessAgentLoop(
    { ...baseOpts, tools: [echoTool('echo', 'ok')], maxTurns: 3, timeoutMs: 10_000 },
    { ...baseDeps(new ScriptedAdapter(turns), new SpyAttestor()), pipeline },
  );
  await assert.rejects(() => loop.run(), ContractViolation);
});
