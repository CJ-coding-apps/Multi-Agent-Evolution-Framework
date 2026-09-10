import type { ProcessorRef } from '@maf/harness-config';
import type { HarnessEvent, ToolResultEvent, StepEndEvent, TaskEndEvent, ToolCallEvent } from './events.js';
import { Processor, ProcessorInterrupt, StaticProcessorRegistry } from './Processor.js';
import type { ProcessorDeps } from './Processor.js';
import { redactText, redactRecord } from './redaction.js';

/**
 * The default bundle (HARNESSX_INTEGRATION_PLAN.md §4.3). Each processor's
 * behavior is specified in its class doc — these are the only processors
 * registered by default, and each fixes or owns a real pipeline behavior:
 *
 *  - policy-audit   records pre-policy tool-call inputs to the transcript
 *  - secret-redact  NEW: strips credentials from tool results before history
 *  - transcript     owns step/task transcript persistence at read-only hooks
 *  - security-gate  runs the coder post-task security review at task_end
 */

// ─── policy-audit ────────────────────────────────────────────────────────────

export class PolicyAuditProcessor extends Processor {
  override readonly name = 'policy-audit';
  override readonly hooks = ['before_tool'] as const;
  override readonly singletonGroup = 'policy-audit';
  override readonly order = 'POST' as const;

  constructor(private readonly deps: ProcessorDeps) { super(); }

  override async *process(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    if (event.hook === 'before_tool' && this.deps.transcript) {
      const e = event as ToolCallEvent;
      // Redact the logged input: a tool call can carry a credential inline
      // (e.g. a command string), and this lands in the transcript pre-gate.
      await this.deps.transcript.append('system',
        `[policy] pre-gate tool call ${e.call.toolName}`,
        { toolName: e.call.toolName, input: redactRecord(e.call.input), stepIndex: e.stepIndex },
      );
    }
    yield event;
  }
}

// ─── secret-redact ───────────────────────────────────────────────────────────

export class SecretRedactProcessor extends Processor {
  override readonly name = 'secret-redact';
  override readonly hooks = ['after_tool'] as const;
  override readonly singletonGroup = 'redaction';
  override readonly order = 'PRE' as const;

  private readonly extra: RegExp[];

  constructor(_deps: ProcessorDeps, config?: Record<string, unknown>) {
    super();
    const raw = config && Array.isArray(config['extraPatterns']) ? config['extraPatterns'] : [];
    this.extra = (raw as unknown[]).filter((s): s is string => typeof s === 'string')
      .map((s) => new RegExp(s, 'g'));
  }

  override async *process(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    if (event.hook !== 'after_tool') { yield event; return; }
    const e = event as ToolResultEvent;
    // Defence in depth: gatedExec already redacts before attestation, so on the
    // in-process path this is typically idempotent; it still covers custom
    // per-harness extraPatterns and any result that skipped the gate path.
    yield {
      ...e,
      result: {
        ...e.result,
        stdout: redactText(e.result.stdout, this.extra),
        stderr: redactText(e.result.stderr, this.extra),
        metadata: redactRecord(e.result.metadata, this.extra),
      },
    };
  }
}

// ─── transcript ──────────────────────────────────────────────────────────────

export class TranscriptProcessor extends Processor {
  override readonly name = 'transcript';
  override readonly hooks = ['step_end', 'task_end'] as const;
  override readonly singletonGroup = 'transcript';

  constructor(private readonly deps: ProcessorDeps) { super(); }

  override async *process(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    if (!this.deps.transcript) { yield event; return; }
    if (event.hook === 'step_end') {
      const e = event as StepEndEvent;
      await this.deps.transcript.append('assistant', e.assistantText, {
        stepIndex: e.stepIndex, toolCallCount: e.toolCallCount, agentRole: e.role,
      });
    } else if (event.hook === 'task_end') {
      const e = event as TaskEndEvent;
      await this.deps.transcript.append('system', `task_end: ${e.outcome}`, {
        outcome: e.outcome, totalSteps: e.totalSteps, agentRole: e.role,
        ...(e.error ? { error: e.error } : {}),
      });
    }
    yield event; // read-only hooks: pass unchanged
  }
}

// ─── security-gate ───────────────────────────────────────────────────────────

export class SecurityGateProcessor extends Processor {
  override readonly name = 'security-gate';
  override readonly hooks = ['task_end'] as const;
  override readonly singletonGroup = 'security-gate';
  override readonly order = 'POST' as const;

  constructor(private readonly deps: ProcessorDeps) { super(); }

  override async *process(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    const e = event as TaskEndEvent;
    // Gate on ANY outcome, not just 'completed' (M2): a coder that hit its turn
    // budget ('budget_exhausted') or errored out can still have left a diff on
    // disk. runPostCoderGates no-ops on an empty diff, so this matches the
    // always-review CLI path exactly instead of leaving a hole.
    if (e.role === 'coder' && this.deps.securityRunner) {
      await this.deps.securityRunner(); // throws on critical/high findings (fail-closed)
    }
    yield event;
  }
}

/** Refs for the default bundle, as they would appear in HarnessConfig.processorBundles. */
export const DEFAULT_BUNDLE_REFS: readonly ProcessorRef[] = [
  { name: 'policy-audit' },
  { name: 'secret-redact' },
  { name: 'transcript' },
  { name: 'security-gate' },
];

/** The static registry with the default bundle (plan §10.2: allowlist-bound, no dynamic loading). */
export function createDefaultProcessorRegistry(): StaticProcessorRegistry {
  return new StaticProcessorRegistry()
    .register('policy-audit', (deps) => new PolicyAuditProcessor(deps))
    .register('secret-redact', (deps, cfg) => new SecretRedactProcessor(deps, cfg))
    .register('transcript', (deps) => new TranscriptProcessor(deps))
    .register('security-gate', (deps) => new SecurityGateProcessor(deps));
}

export { ProcessorInterrupt };
