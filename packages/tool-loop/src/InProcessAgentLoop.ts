import { makeAgentId, estimateTokens } from '@maf/types';
import type {
  RunId, TaskId, TurnAdapter, TurnMessage, ToolPlugin, ToolContext,
  PolicyEngineHandle, AttestorHandle, AssistantTurn, ToolCallRequest, ToolResult, ApprovalGateHandle,
  ModelSurfaceRecord,
} from '@maf/types';
import { ProcessorInterrupt, ContractViolation } from '@maf/processors';
import type { ProcessorPipeline, HarnessEvent, HookPoint } from '@maf/processors';
import { PolicyViolationError } from '@maf/policy-engine';
import { executeToolGated } from './gatedExec.js';

export interface InProcessLoopOptions {
  role:          string;
  harnessSha:    string;
  systemPrompt:  string;
  userPrompt:    string;
  tools:         ToolPlugin[];
  maxTurns:      number;
  timeoutMs:     number;
  workingDir:    string;
  projectRoot:   string;
  sessionId:     string;
  maxOutputBytes?: number;
  tokenBudget?:  number;
  model?:        string;
  /** Max corrective retries when the model emits a malformed tool_call block (default 3). */
  maxToolCallRepairs?: number;
}

/**
 * The transcript, as the loop needs it: one method. A `TranscriptLogger` satisfies it structurally,
 * so the loop does not depend on `@maf/transcript` for a type.
 */
export interface TranscriptSink {
  append(
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface InProcessLoopDeps {
  adapter:    TurnAdapter;
  policy:     PolicyEngineHandle;
  attestor:   AttestorHandle;
  runId:      RunId;
  taskId:     TaskId;
  pipeline?:  ProcessorPipeline;
  /** Where each turn's model surface is written (F4); omitted when there is no transcript to write. */
  transcript?: TranscriptSink;
  /** Asked when the policy escalates a call (D-02); reaches executeToolGated with these deps. */
  approvalGate?: ApprovalGateHandle | undefined;
}

export interface InProcessLoopResult {
  outcome:   'completed' | 'budget_exhausted' | 'failed';
  finalText: string;
  steps:     number;
  history:   TurnMessage[];
  error?:    string;
}

const errorResult = (content: string): ToolResult => ({
  stdout: '', stderr: content, exitCode: 1, duration: 0, metadata: { gated: true },
});

/**
 * InProcessAgentLoop — a real multi-turn agent loop where every tool call
 * passes through the processor pipeline and the policy gate before executing
 * (README.md, "In-process execution & the tool-call protocol"). Total with
 * respect to the run: it returns a result for every path and only lets
 * ContractViolation / security-gate failures propagate (both deliberate,
 * loud failures).
 */
export class InProcessAgentLoop {
  constructor(
    private readonly opts: InProcessLoopOptions,
    private readonly deps: InProcessLoopDeps,
  ) {}

  async run(): Promise<InProcessLoopResult> {
    const pipeline = this.deps.pipeline;
    const base = {
      runId: this.deps.runId, taskId: this.deps.taskId,
      role: this.opts.role, harnessSha: this.opts.harnessSha,
    };
    const o = this.opts;
    const maxRepairs = o.maxToolCallRepairs ?? 3;

    // ── task_start: PromptAssembly/processors may edit the system prompt ──
    let systemPrompt = o.systemPrompt;
    if (pipeline) {
      const events = await pipeline.run({
        ...base, hook: 'task_start', systemPrompt, userPrompt: o.userPrompt,
      });
      const first = this.firstEvent<{ systemPrompt: string }>(events, 'task_start');
      if (first) systemPrompt = first.systemPrompt;
    }

    let history: TurnMessage[] = [{ kind: 'user', text: o.userPrompt }];
    let tokensUsed = 0;
    let stepIndex = 0;
    let outcome: InProcessLoopResult['outcome'] = 'completed';
    let finalText = '';
    let error: string | undefined;

    const toolByName = new Map(o.tools.map((t) => [t.id as string, t]));

    while (stepIndex < o.maxTurns) {
      const stepAt = stepIndex;
      try {
        // ── step_start: structural history edits ──
        if (pipeline) {
          const ev = await pipeline.run({ ...base, hook: 'step_start', stepIndex: stepAt, history: [...history] });
          const first = this.firstEvent<{ history: TurnMessage[] }>(ev, 'step_start');
          if (first) history = first.history;
          else { outcome = 'budget_exhausted'; break; }   // intercept → stop
        }
        // ── before_model: last-message edit / single append ──
        if (pipeline) {
          const ev = await pipeline.run({ ...base, hook: 'before_model', stepIndex: stepAt, history: [...history] });
          const first = this.firstEvent<{ history: TurnMessage[] }>(ev, 'before_model');
          if (first) history = first.history;
        }

        // prompt sent to the model this turn = current history (pre-assistant)
        let promptHistory = history;
        let modelTurn = await this.runModelTurn(base, stepAt, promptHistory, systemPrompt);
        if (modelTurn.intercepted) { outcome = 'failed'; error = 'intercepted at after_model'; break; }
        let processedTurn = modelTurn.turn;
        tokensUsed += processedTurn.tokensUsed ?? this.estimateTurnTokens(promptHistory, processedTurn);

        // ── bounded repair loop (L?/live): the model emitted a malformed tool_call
        // block and no valid call parsed. Feed back the exact error + format and
        // retry, up to maxToolCallRepairs, rather than silently dropping the call. ──
        let repairs = 0;
        while (needsRepair(processedTurn) && repairs < maxRepairs) {
          repairs++;
          history = [...history, { kind: 'user', text: repairMessage(processedTurn.parseErrors ?? [], repairs, maxRepairs) }];
          promptHistory = history;
          modelTurn = await this.runModelTurn(base, stepAt, promptHistory, systemPrompt);
          if (modelTurn.intercepted) break;
          processedTurn = modelTurn.turn;
          tokensUsed += processedTurn.tokensUsed ?? this.estimateTurnTokens(promptHistory, processedTurn);
        }
        if (modelTurn.intercepted) { outcome = 'failed'; error = 'intercepted at after_model'; break; }
        if (needsRepair(processedTurn)) {
          history = [...history, {
            kind: 'assistant', text: processedTurn.text, toolCalls: processedTurn.toolCalls,
          }];
          outcome = 'failed';
          error = `model emitted a malformed tool_call block after ${maxRepairs} repair attempt(s): ${(processedTurn.parseErrors ?? []).join('; ')}`;
          await this.stepEnd(base, stepAt, processedTurn.text, 0);
          break;
        }

        history = [...history, {
          kind: 'assistant', text: processedTurn.text, toolCalls: processedTurn.toolCalls,
        }];

        if (processedTurn.toolCalls.length === 0) {
          finalText = processedTurn.text;
          await this.stepEnd(base, stepAt, processedTurn.text, 0);
          break;
        }

        // ── tool dispatch, fully gated ──
        for (const call of processedTurn.toolCalls) {
          history = [...history, await this.dispatchTool(base, stepAt, call, toolByName)];
        }
        await this.stepEnd(base, stepAt, processedTurn.text, processedTurn.toolCalls.length);

        if (o.tokenBudget !== undefined && tokensUsed > o.tokenBudget) {
          outcome = 'budget_exhausted';
          break;
        }
        stepIndex++;
      } catch (err) {
        if (err instanceof ProcessorInterrupt) {
          outcome = 'failed';
          error = err.message;
          break;
        }
        throw err; // ContractViolation, security-gate failure: deliberate, loud
      }
    }

    if (stepIndex >= o.maxTurns && outcome === 'completed' && finalText === '') {
      outcome = 'budget_exhausted';
      error = `hit maxTurns=${o.maxTurns}`;
    }
    if (finalText === '') {
      const lastAssistant = [...history].reverse().find((m) => m.kind === 'assistant');
      finalText = lastAssistant && lastAssistant.kind === 'assistant' ? lastAssistant.text : '';
    }

    // ── task_end: read-only observation (transcript, security gate) ──
    const endEvent: HarnessEvent = {
      ...base, hook: 'task_end', finalText, totalSteps: stepIndex + 1, outcome,
      ...(error ? { error } : {}),
    };
    if (pipeline) await pipeline.run(endEvent);

    return { outcome, finalText, steps: stepIndex + 1, history, ...(error ? { error } : {}) };
  }

  /**
   * Single-consumer hook accessor (L3): the serving loop acts on exactly one
   * event per hook. 0 events = intercept (caller decides). >1 = a processor
   * split, which the loop cannot honor (it would fork the conversation) — fail
   * loudly instead of silently dropping branches.
   */
  private firstEvent<T>(events: HarnessEvent[], hook: HookPoint): T | undefined {
    if (events.length > 1) {
      throw new ContractViolation(
        '<in-process-loop>', hook,
        `hook emitted ${events.length} events; split is not supported in the serving loop`,
      );
    }
    return events[0] as T | undefined;
  }

  /** Coarse per-turn token estimate (prompt + completion) for budget enforcement. */
  private estimateTurnTokens(promptHistory: TurnMessage[], turn: AssistantTurn): number {
    const parts: string[] = [];
    for (const m of promptHistory) {
      if (m.kind === 'assistant') parts.push(m.text, JSON.stringify(m.toolCalls));
      else if (m.kind === 'tool') parts.push(m.content);
      else parts.push(m.text);
    }
    parts.push(turn.text, JSON.stringify(turn.toolCalls));
    return estimateTokens(parts.join('\n'));
  }

  private async stepEnd(
    base: { runId: RunId; taskId: TaskId; role: string; harnessSha: string },
    stepIndex: number,
    assistantText: string,
    toolCallCount: number,
  ): Promise<void> {
    if (!this.deps.pipeline) return;
    await this.deps.pipeline.run({
      ...base, hook: 'step_end', stepIndex, assistantText, toolCallCount,
    });
  }

  /**
   * One model call + the after_model hook. Returns the processed turn, or
   * `intercepted: true` when a processor intercepted the response. Used for both
   * the primary turn and each repair retry.
   */
  private async runModelTurn(
    base: { runId: RunId; taskId: TaskId; role: string; harnessSha: string },
    stepIndex: number,
    promptHistory: TurnMessage[],
    systemPrompt: string,
  ): Promise<{ turn: AssistantTurn; intercepted: boolean }> {
    const turn = await this.callModel(promptHistory, systemPrompt);
    await this.recordSurface(base, stepIndex, turn);
    if (!this.deps.pipeline) return { turn, intercepted: false };
    const ev = await this.deps.pipeline.run({ ...base, hook: 'after_model', stepIndex, turn });
    const first = this.firstEvent<{ turn: AssistantTurn }>(ev, 'after_model');
    if (!first) return { turn, intercepted: true };
    return { turn: first.turn, intercepted: false };
  }

  /**
   * Records what this turn showed the model (F4), to the bundle and the transcript. It runs before
   * the `after_model` hook, because the evidence is about what the model *was shown*, which no
   * processor that edits the turn can change after the fact.
   */
  private async recordSurface(
    base: { runId: RunId; taskId: TaskId; role: string },
    stepIndex: number,
    turn: AssistantTurn,
  ): Promise<void> {
    const surface = turn.modelSurface;
    if (!surface) return;
    const record: ModelSurfaceRecord = {
      role: base.role, taskId: base.taskId, turn: stepIndex + 1, ...surface,
    };
    this.deps.attestor.recordModelSurface?.(record);
    await this.deps.transcript?.append(
      'system',
      `[surface] turn ${record.turn}: system sha256 ${record.systemPromptSha256}; argv ${JSON.stringify(record.argv)}`,
      { agentRole: record.role, taskId: record.taskId, turn: record.turn,
        systemPromptSha256: record.systemPromptSha256, toolCatalog: record.toolCatalog, argv: record.argv },
    );
  }

  private async callModel(history: TurnMessage[], systemPrompt: string): Promise<AssistantTurn> {
    const o = this.opts;
    const invokeOpts = {
      prompt:     '[turn]',
      systemPrompt,
      workingDir: o.workingDir,
      timeoutMs:  o.timeoutMs,
      ...(o.maxOutputBytes !== undefined ? { maxOutputBytes: o.maxOutputBytes } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
      tools: o.tools,
    };
    return this.deps.adapter.sendTurn(history, invokeOpts);
  }

  private async dispatchTool(
    base: { runId: RunId; taskId: TaskId; role: string; harnessSha: string },
    stepIndex: number,
    call: ToolCallRequest,
    toolByName: Map<string, ToolPlugin>,
  ): Promise<TurnMessage> {
    const pipeline = this.deps.pipeline;

    // ── before_tool: processors may edit input/approval; intercept = skip ──
    let processed = { ...call };
    if (pipeline) {
      const ev = await pipeline.run({ ...base, hook: 'before_tool', stepIndex, call: { ...call } });
      const first = this.firstEvent<{ call: ToolCallRequest }>(ev, 'before_tool');
      if (!first) {
        return { kind: 'tool', toolUseId: call.toolUseId, toolName: call.toolName,
                 content: 'tool call intercepted by processor pipeline', isError: true };
      }
      processed = first.call;
    }

    const tool = toolByName.get(processed.toolName);
    if (!tool) {
      return { kind: 'tool', toolUseId: processed.toolUseId, toolName: processed.toolName,
               content: `tool not in this role's allowlist: ${processed.toolName}`, isError: true };
    }

    let result: ToolResult;
    try {
      const ctx: ToolContext = {
        cwd: this.opts.workingDir,
        projectRoot: this.opts.projectRoot,
        runId: this.deps.runId,
        taskId: this.deps.taskId,
        agentId: makeAgentId(`inprocess-${this.opts.role}-${this.deps.taskId}`),
        sessionId: this.opts.sessionId,
        agentRole: this.opts.role,
        policy: this.deps.policy,
        attestor: this.deps.attestor,
      };
      result = await executeToolGated(tool, processed.input, ctx, this.deps);
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        result = errorResult(`policy ${err.decision.verdict}: ${err.decision.reason}`);
      } else {
        throw err;
      }
    }

    // ── after_tool: result transforms (e.g. secret redaction) ──
    if (pipeline) {
      const ev = await pipeline.run({ ...base, hook: 'after_tool', stepIndex, call: processed, result });
      const first = this.firstEvent<{ result: ToolResult }>(ev, 'after_tool');
      if (first) result = first.result;
    }

    return {
      kind: 'tool',
      toolUseId: processed.toolUseId,
      toolName: processed.toolName,
      content: result.exitCode === 0 ? result.stdout : (result.stderr || result.stdout),
      isError: result.exitCode !== 0,
    };
  }
}

/**
 * A turn needs repair when the model emitted a malformed tool_call block and NO
 * valid tool call was parsed — i.e. it clearly intended a tool call but got the
 * format wrong. If at least one valid call parsed, we proceed with those.
 */
function needsRepair(turn: AssistantTurn): boolean {
  return (turn.parseErrors?.length ?? 0) > 0 && turn.toolCalls.length === 0;
}

/** Corrective feedback appended to the conversation before a repair retry. */
function repairMessage(errors: string[], attempt: number, max: number): string {
  return [
    `[tool-call repair ${attempt}/${max}] Your previous message contained a malformed tool_call block and no valid tool call was parsed.`,
    `Parser error(s): ${errors.join('; ')}`,
    'Re-issue the tool call using EXACTLY this format — one fenced block, strictly valid JSON, no trailing commas or comments:',
    '```tool_call',
    '{"toolName":"<tool-id>","input":{ ... }}',
    '```',
    'Use a tool id from the AVAILABLE TOOLS list. If you did not intend to call a tool, reply with plain text and no fenced tool_call block.',
  ].join('\n');
}
