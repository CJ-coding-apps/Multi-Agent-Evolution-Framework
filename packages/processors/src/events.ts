import type {
  RunId, TaskId, TurnMessage, AssistantTurn, ToolCallRequest, ToolResult,
} from '@maf/types';

/**
 * Hook-indexed typed events for the processor pipeline.
 * Permitted-modification contracts are enforced by ProcessorPipeline after
 * EVERY processor invocation (HARNESSX_INTEGRATION_PLAN.md §4.2).
 */

export type HookPoint =
  | 'task_start'
  | 'step_start'
  | 'before_model'
  | 'after_model'
  | 'before_tool'
  | 'after_tool'
  | 'step_end'
  | 'task_end';

export interface EventBase {
  readonly hook: HookPoint;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly role: string;
  readonly harnessSha: string;
}

export interface TaskStartEvent extends EventBase {
  readonly hook: 'task_start';
  /** MUTABLE: system prompt presented to the model. */
  systemPrompt: string;
  readonly userPrompt: string;
}

export interface StepStartEvent extends EventBase {
  readonly hook: 'step_start';
  readonly stepIndex: number;
  /** MUTABLE: structural history edits (truncate / reorder / annotate). */
  history: TurnMessage[];
}

export interface BeforeModelEvent extends EventBase {
  readonly hook: 'before_model';
  readonly stepIndex: number;
  /**
   * MUTABLE with constraints: a processor may edit the last user message's
   * text and/or append at most ONE user message. Enforced by contract check.
   */
  history: TurnMessage[];
}

export interface ModelResponseEvent extends EventBase {
  readonly hook: 'after_model';
  readonly stepIndex: number;
  /** MUTABLE: response text and requested tool calls. */
  turn: AssistantTurn;
}

export interface ToolCallEvent extends EventBase {
  readonly hook: 'before_tool';
  readonly stepIndex: number;
  /** MUTABLE: tool input and approval flag. Policy evaluation runs AFTER this hook. */
  call: ToolCallRequest & { approvalRequired?: boolean };
}

export interface ToolResultEvent extends EventBase {
  readonly hook: 'after_tool';
  readonly stepIndex: number;
  readonly call: ToolCallRequest;
  /** MUTABLE: result content (stdout/stderr/metadata) before it enters history. */
  result: ToolResult;
}

export interface StepEndEvent extends EventBase {
  readonly hook: 'step_end';
  readonly stepIndex: number;
  readonly assistantText: string;
  readonly toolCallCount: number;
}

export interface TaskEndEvent extends EventBase {
  readonly hook: 'task_end';
  readonly finalText: string;
  readonly totalSteps: number;
  readonly outcome: 'completed' | 'failed' | 'budget_exhausted';
  readonly error?: string;
}

export type HarnessEvent =
  | TaskStartEvent
  | StepStartEvent
  | BeforeModelEvent
  | ModelResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepEndEvent
  | TaskEndEvent;

export const ALL_HOOKS: readonly HookPoint[] = [
  'task_start', 'step_start', 'before_model', 'after_model',
  'before_tool', 'after_tool', 'step_end', 'task_end',
];

/**
 * Permitted mutations per hook. Keys are dot-path prefixes relative to the
 * event object; anything outside the list must deep-equal the input event.
 * Empty = read-only hook.
 */
export const HOOK_CONTRACTS: Record<HookPoint, readonly string[]> = {
  task_start:   ['systemPrompt'],
  step_start:   ['history'],
  before_model: ['history'],
  after_model:  ['turn'],
  before_tool:  ['call.input', 'call.approvalRequired'],
  after_tool:   ['result'],
  step_end:     [],
  task_end:     [],
};

/** Hooks where yielding zero events (intercept) is legal. Read-only hooks are observation-only. */
export const INTERCEPTABLE: ReadonlySet<HookPoint> = new Set<HookPoint>([
  'task_start', 'step_start', 'before_model', 'after_model', 'before_tool', 'after_tool',
]);
