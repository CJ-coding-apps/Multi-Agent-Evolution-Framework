import type { ProcessorRef } from '@maf/harness-config';
import type { HookPoint, HarnessEvent } from './events.js';
import { HOOK_CONTRACTS, INTERCEPTABLE } from './events.js';
import {
  ContractViolation,
  StaticProcessorRegistry,
} from './Processor.js';
import type { Processor, ProcessorDeps, ProcessorFactory } from './Processor.js';

const ORDER_RANK: Record<string, number> = { PRE: 0, NORMAL: 1, POST: 2 };

/**
 * ProcessorPipeline — hook-indexed, contract-enforced composition of processors.
 * Pure with respect to events: effects live inside processors' injected deps,
 * never in pipeline state. Pipeline instances are per-node-run (private state).
 */
export class ProcessorPipeline {
  private readonly byHook = new Map<HookPoint, Processor[]>();

  private constructor(processors: Processor[]) {
    for (const p of processors) {
      for (const hook of p.hooks) {
        const list = this.byHook.get(hook) ?? [];
        list.push(p);
        this.byHook.set(hook, list);
      }
    }
    for (const list of this.byHook.values()) {
      list.sort((a, b) => ORDER_RANK[a.order]! - ORDER_RANK[b.order]!);
    }
  }

  static build(
    refs: ProcessorRef[],
    registry: StaticProcessorRegistry,
    deps: ProcessorDeps,
  ): ProcessorPipeline {
    const processors = refs.map((ref) => registry.create(ref, deps));

    // Singleton-group exclusion
    const seenGroups = new Map<string, string>();
    for (const p of processors) {
      if (!p.singletonGroup) continue;
      const prior = seenGroups.get(p.singletonGroup);
      if (prior) {
        throw new ContractViolation(
          p.name, p.hooks[0] ?? 'task_start',
          `singleton group "${p.singletonGroup}" already occupied by "${prior}"`,
        );
      }
      seenGroups.set(p.singletonGroup, p.name);
    }

    // softAfter ordering within each hook: apply stable topological bumps
    const sorted = topologicalOrder(processors);
    return new ProcessorPipeline(sorted);
  }

  names(): string[] {
    const out = new Set<string>();
    for (const list of this.byHook.values()) for (const p of list) out.add(p.name);
    return [...out];
  }

  /**
   * Run the gauntlet for one hook. Returns the processed event stream —
   * empty array means every branch was intercepted (the loop decides what
   * interception means per hook). Split branches flow independently through
   * downstream processors.
   */
  async run(event: HarnessEvent): Promise<HarnessEvent[]> {
    const hook = event.hook;
    const processors = this.byHook.get(hook);
    if (!processors || processors.length === 0) return [event];

    let current: HarnessEvent[] = [event];
    for (const processor of processors) {
      const next: HarnessEvent[] = [];
      for (const e of current) {
        // Checked against a copy taken before the processor runs: a processor
        // that edits `e` in place and yields it makes input and output the same
        // object, so comparing against `e` would pass any in-place change.
        const before = snapshot(e);
        const emitted = await collect(processor, e);
        for (const out of emitted) {
          validateContract(processor, hook, before, out);
          next.push(out);
        }
        // `e` shares sub-objects with the caller (the loop hands over a shallow
        // history copy), so an in-place edit followed by an intercept or by a
        // fresh copy would otherwise reach the caller unchecked. Skipped when `e`
        // itself was yielded, since that case was just checked above.
        if (!emitted.includes(e)) validateContract(processor, hook, before, e);
      }
      current = next;
      if (current.length === 0) {
        if (!INTERCEPTABLE.has(hook)) {
          throw new ContractViolation(processor.name, hook, 'intercepted a read-only hook');
        }
        break;
      }
    }
    return current;
  }
}

async function collect(processor: Processor, event: HarnessEvent): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of processor.process(event)) out.push(e);
  return out;
}

function topologicalOrder(processors: Processor[]): Processor[] {
  // Kahn-lite: softAfter references group names; processors without a group are
  // anchors satisfied only by order rank (handled in constructor sort).
  const result: Processor[] = [];
  const placedGroups = new Set<string>();
  const remaining = [...processors];
  let guard = processors.length * processors.length + 1;

  while (remaining.length > 0) {
    if (guard-- <= 0) {
      throw new ContractViolation(
        '<pipeline>', 'task_start',
        `softAfter cycle among: ${remaining.map((p) => p.name).join(', ')}`,
      );
    }
    const idx = remaining.findIndex((p) =>
      p.softAfter.every((g) => placedGroups.has(g) || !processors.some((q) => q.singletonGroup === g)),
    );
    const pick = idx >= 0 ? idx : 0;
    const [p] = remaining.splice(pick, 1);
    if (!p) break;
    result.push(p);
    if (p.singletonGroup) placedGroups.add(p.singletonGroup);
  }
  return result.sort((a, b) => ORDER_RANK[a.order]! - ORDER_RANK[b.order]!);
}

/**
 * Pre-processor copy of an event for the contract check. It keeps exactly what
 * `canonical` observes (arrays element-wise, other objects as their own
 * enumerable entries, everything else as is), so an untouched event always
 * compares equal to its snapshot. `ToolInput` and `ToolResult.metadata` hold
 * `unknown` values: a JSON round-trip would drop undefined-valued keys (git.commit
 * emits `metadata.hash: undefined`) and turn a Date into a string, and
 * structuredClone throws on a function — each would raise false violations.
 * Strings are shared rather than copied, so the cost is one walk of the object
 * graph whatever the text sizes. Freezing the event instead was rejected: a
 * write to a frozen object surfaces as a TypeError inside the processor rather
 * than a ContractViolation, it would freeze objects the caller owns, and it
 * would forbid the in-place edits the contract permits.
 */
function snapshot(event: HarnessEvent): HarnessEvent {
  return copyStructure(event) as HarnessEvent;
}

function copyStructure(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(copyStructure);
  if (v && typeof v === 'object') {
    // fromEntries defines own properties, so a JSON-parsed "__proto__" key in a
    // tool input stays a key instead of becoming the copy's prototype.
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]): [string, unknown] => [k, copyStructure(val)]),
    );
  }
  return v;
}

/** Deep-compare two values via canonical JSON (key order irrelevant). */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Contract check: fields outside HOOK_CONTRACTS[hook] must deep-equal the
 * input. Mutable fields are checked per-prefix from the contract table.
 * `input` must be a snapshot taken before the processor ran; the live input
 * object already carries any edit the processor made in place.
 */
export function validateContract(
  processor: Processor,
  hook: HookPoint,
  input: HarnessEvent,
  output: HarnessEvent,
): void {
  if (output.hook !== hook) {
    throw new ContractViolation(processor.name, hook, `emitted event has hook "${output.hook}"`);
  }
  const allowed = HOOK_CONTRACTS[hook];
  checkImmutablePrefix(processor, hook, input as unknown as Record<string, unknown>, output as unknown as Record<string, unknown>, allowed, '');

  // Hook-specific constraints beyond field-level mutability:
  if (hook === 'before_model') {
    const beforeHistory = (input as { history: unknown[] }).history;
    const afterHistory = (output as { history: unknown[] }).history;
    validateBeforeModelHistory(processor, hook, beforeHistory, afterHistory);
  }
}

/**
 * before_model contract (events.ts): a processor may edit the LAST user
 * message's text and/or append AT MOST ONE user message — nothing else. This
 * enforces it structurally (prior history is immutable here; truncation/reorder
 * belongs to step_start, not before_model).
 */
function validateBeforeModelHistory(
  processor: Processor,
  hook: HookPoint,
  before: unknown[],
  after: unknown[],
): void {
  if (after.length > before.length + 1)
    throw new ContractViolation(processor.name, hook, 'appended more than one message');
  if (after.length < before.length)
    throw new ContractViolation(processor.name, hook, 'removed history messages (use step_start to truncate/reorder)');

  // Every message before the last pre-existing one must be byte-identical.
  for (let i = 0; i < before.length - 1; i++) {
    if (!deepEqual(before[i], after[i]))
      throw new ContractViolation(processor.name, hook, `rewrote prior history message at index ${i}`);
  }
  // The last pre-existing message: only a user message's text may change.
  if (before.length > 0) {
    const lastB = before[before.length - 1] as { kind?: string };
    const lastA = after[before.length - 1] as { kind?: string };
    const bothUser = lastB?.kind === 'user' && lastA?.kind === 'user';
    if (!bothUser && !deepEqual(lastB, lastA))
      throw new ContractViolation(processor.name, hook, 'rewrote the last history message beyond editing user text');
  }
  // An appended message (if any) must be a user message.
  if (after.length === before.length + 1) {
    const appended = after[after.length - 1] as { kind?: string };
    if (appended?.kind !== 'user')
      throw new ContractViolation(processor.name, hook, 'appended message must be a user message');
  }
}

function checkImmutablePrefix(
  processor: Processor,
  hook: HookPoint,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  /** The full dot-path allowlist for this hook (never sliced — paths stay absolute). */
  allowed: readonly string[],
  prefix: string,
): void {
  // Union of keys so a DELETED immutable field is caught, not only added/mutated ones.
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (allowed.includes(path)) continue;                   // whole subtree mutable
    const hasMutableChildren = allowed.some((a) => a.startsWith(`${path}.`));
    const pv = before[key];
    const av = after[key];
    if (hasMutableChildren) {
      // Parent is immutable but has mutable descendants — recurse, don't compare.
      if (!isPlain(pv) || !isPlain(av)) {
        throw new ContractViolation(processor.name, hook, `replaced non-object parent at "${path}"`);
      }
      checkImmutablePrefix(processor, hook, pv, av, allowed, path);
      continue;
    }
    if (!deepEqual(pv, av)) {
      throw new ContractViolation(processor.name, hook, `mutated read-only field "${path}"`);
    }
  }
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
