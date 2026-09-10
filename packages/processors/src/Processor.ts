import type { ProcessorRef } from '@maf/harness-config';
import type { HookPoint, HarnessEvent } from './events.js';

export class ContractViolation extends Error {
  readonly processorName: string;
  readonly hook: HookPoint;
  constructor(processorName: string, hook: HookPoint, detail: string) {
    super(`Contract violation by processor "${processorName}" at hook "${hook}": ${detail}`);
    this.name = 'ContractViolation';
    this.processorName = processorName;
    this.hook = hook;
  }
}

/** Thrown by a processor to halt the loop deliberately (interrupt outcome). */
export class ProcessorInterrupt extends Error {
  readonly processorName: string;
  constructor(processorName: string, reason: string) {
    super(`Interrupt by processor "${processorName}": ${reason}`);
    this.name = 'ProcessorInterrupt';
    this.processorName = processorName;
  }
}

export interface ProcessorContext {
  cwd:       string;
  sessionId: string;
}

/**
 * Dependencies a bundle processor may declare. Kept minimal by design —
 * processors are the pure core; the loop shell owns the heavyweight handles.
 * All fields optional so processors declare exactly what they need.
 */
export interface ProcessorDeps {
  transcript?: {
    append(role: 'user' | 'assistant' | 'system' | 'tool', content: string, metadata?: Record<string, unknown>): Promise<unknown>;
  };
  /** Names a runner for the coder security gate; used by SecurityGateProcessor. */
  securityRunner?: () => Promise<void>;
}

export type ProcessorFactory = (
  deps: ProcessorDeps,
  config: Record<string, unknown> | undefined,
) => Processor;

/**
 * A Processor consumes one HarnessEvent and yields zero or more processed
 * events of the same hook type:
 *   pass-through   yield the event unchanged (or nothing to yield = same)
 *   transform      yield a modified copy
 *   split          yield ≥2 events (processed independently downstream)
 *   intercept      yield zero events (blocks propagation, only on interceptable hooks)
 *   interrupt      throw ProcessorInterrupt (halts the loop)
 */
export abstract class Processor {
  abstract readonly name: string;
  /** Hook points this processor attaches to. */
  abstract readonly hooks: readonly HookPoint[];
  /** Mutual exclusion: at most one processor per group may be built into a pipeline. */
  readonly singletonGroup?: string;
  /** Ordering hint within a hook: PRE runs before NORMAL before POST. */
  readonly order: 'PRE' | 'NORMAL' | 'POST' = 'NORMAL';
  /** Soft dependencies: names of singleton groups that must run first (same hook). */
  readonly softAfter: readonly string[] = [];

  abstract process(event: HarnessEvent): AsyncGenerator<HarnessEvent>;

  /** Convenience for pass-through processors. */
  protected async *pass(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    yield event;
  }
}

/** Static (compiled-in) registry — the ONLY way refs resolve in v1 (plan §10.2). */
export class StaticProcessorRegistry {
  private readonly factories = new Map<string, ProcessorFactory>();

  register(name: string, factory: ProcessorFactory): this {
    if (this.factories.has(name)) throw new Error(`Duplicate processor registration: ${name}`);
    this.factories.set(name, factory);
    return this;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  names(): string[] {
    return [...this.factories.keys()];
  }

  /** Resolve a harness-config ref; unknown names fail loudly here, not mid-run. */
  create(
    ref: ProcessorRef,
    deps: ProcessorDeps,
  ): Processor {
    const factory = this.factories.get(ref.name);
    if (!factory) throw new Error(`Unknown processor ref: ${JSON.stringify(ref.name)}`);
    return factory(deps, ref.config);
  }
}
