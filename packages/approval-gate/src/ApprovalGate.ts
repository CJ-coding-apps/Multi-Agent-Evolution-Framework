import path from 'node:path';
import tty from 'node:tty';
import type {
  ApprovalAsk, ApprovalGateHandle, ApprovalOutcome, ApprovalRequest, ApprovalStatus, ToolInput,
} from '@maf/types';
import { AttestationRecorder } from './AttestationRecorder.js';
import type { ApprovalSink } from './AttestationRecorder.js';
import { approvalRequestHash } from './requestHash.js';
import { TtyApprovalProvider } from './providers/tty.js';
import { HeadlessApprovalProvider } from './providers/headless.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
// setTimeout fires at once for anything longer, which would turn a generous timeout into a denial.
const MAX_TIMEOUT_MS = 2_147_483_647;
const GATE = 'maf-approval-gate';

// Ids name the pending record's file, so they are a file-name-safe token and nothing else.
const USABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A request a provider is asked to decide, with the hash its answer must carry back. */
export interface PendingApproval {
  readonly requestId:     string;
  readonly requestHash:   string;
  readonly request:       ApprovalRequest;
  readonly toolId:        string;
  /** What the call will run on; a terminal shows a bounded preview of it. */
  readonly input:         ToolInput;
  readonly declaredPaths: readonly string[];
  readonly timeoutMs:     number;
}

export interface ProviderAnswer {
  requestId:   string;
  requestHash: string;
  approved:    boolean;
  reviewer:    string;
  reason:      string;
}

/** A way of asking a human. `signal` aborts when the gate stops waiting (timeout). */
export interface ApprovalProvider {
  /**
   * True when the provider may hold a request back before asking — one prompt at a time on a
   * terminal. It then calls `asking` when it shows the request, and the timeout runs from there:
   * the prompt promises the operator the whole timeout. Otherwise the clock starts at `ask`.
   */
  readonly queues?: boolean;
  ask(pending: PendingApproval, signal: AbortSignal, asking: () => void): Promise<ProviderAnswer>;
}

export interface ApprovalGateConfig {
  provider:   ApprovalProvider;
  recorder:   ApprovalSink;
  timeoutMs?: number;
}

interface Settlement {
  status:   ApprovalStatus;
  reviewer: string;
  reason:   string;
}

const TIMED_OUT = Symbol('timed out');

/**
 * The approval gate for `Escalate` verdicts (D-02). Every request it is given is settled exactly
 * once and recorded in the attestation, approved or not; an approval is good for the request it
 * names, bound to that request's hash, and for nothing else.
 */
export class ApprovalGate implements ApprovalGateHandle {
  private readonly pending = new Map<string, PendingApproval>();
  // Every id ever seen, pending or settled: an id is good for one decision.
  private readonly seen = new Set<string>();
  private readonly recorder: AttestationRecorder;
  private readonly timeoutMs: number;

  constructor(private readonly config: ApprovalGateConfig) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `The approval timeout must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}; found ${String(timeoutMs)}.`,
      );
    }
    this.timeoutMs = timeoutMs;
    this.recorder = new AttestationRecorder(config.recorder);
  }

  /** Ids waiting on an answer now. A settled request — whatever settled it — is not among them. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  async decide(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    // `?.` throughout: the ask is built from whatever implements the policy handle.
    const requestId: unknown = ask.request?.id;
    const id = typeof requestId === 'string' ? requestId : '';
    let requestHash = '';
    try {
      requestHash = approvalRequestHash(ask);
    } catch (err) {
      return this.settle(ask, id, '', refused(`the request cannot be bound to a hash: ${messageOf(err)}`));
    }
    if (!USABLE_ID.test(id)) {
      return this.settle(ask, id, requestHash, refused(
        `request id ${JSON.stringify(requestId)} is not usable; expected 1-128 letters, digits, ".", "_" or "-", starting with a letter or digit`,
      ));
    }
    if (this.seen.has(id)) {
      return this.settle(ask, id, requestHash, refused(`request id "${id}" was already used; an id is good for one decision`));
    }
    this.seen.add(id);
    if (ask.request.toolId !== undefined && ask.request.toolId !== ask.toolId) {
      return this.settle(ask, id, requestHash, refused(
        `the request names tool "${ask.request.toolId}" but the call is to "${ask.toolId}"`,
      ));
    }

    const pending: PendingApproval = {
      requestId: id, requestHash, request: ask.request, toolId: ask.toolId, input: ask.input,
      declaredPaths: [...ask.declaredPaths], timeoutMs: this.timeoutMs,
    };
    this.pending.set(id, pending);
    let answer: ProviderAnswer | typeof TIMED_OUT | Error;
    try {
      answer = await this.waitForAnswer(pending);
    } finally {
      this.pending.delete(id);
    }
    return this.settle(ask, id, requestHash, this.judge(ask, pending, answer));
  }

  private async waitForAnswer(pending: PendingApproval): Promise<ProviderAnswer | typeof TIMED_OUT | Error> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    let startClock = (): void => undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      // Once, and never after the wait is over: a timer set then would hold the process open.
      startClock = (): void => {
        if (!done) timer ??= setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
      };
    });
    if (this.config.provider.queues !== true) startClock();
    try {
      // `then` so a provider that throws synchronously is a refusal like one that rejects.
      const asked = Promise.resolve().then(() => this.config.provider.ask(pending, controller.signal, startClock));
      return await Promise.race([asked, timedOut]);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    } finally {
      done = true;
      clearTimeout(timer);
      // Tells the provider to stop listening; a late answer then has nowhere to land.
      controller.abort();
    }
  }

  private judge(ask: ApprovalAsk, pending: PendingApproval, answer: ProviderAnswer | typeof TIMED_OUT | Error): Settlement {
    if (answer === TIMED_OUT) {
      return { status: 'TimedOut', reviewer: GATE, reason: `no decision within ${this.timeoutMs} ms, so the call is refused` };
    }
    if (answer instanceof Error) return refused(`the approval provider failed: ${answer.message}`);
    // Typed as an answer, but it is whatever the provider resolved: reading fields off `undefined`
    // would throw past the record, and the refusal would leave no trace in the bundle.
    const given: unknown = answer;
    if (typeof given !== 'object' || given === null) {
      return refused(`the approval provider answered ${given === null ? 'null' : typeof given} instead of a decision`);
    }
    if (answer.requestId !== pending.requestId) {
      const used = this.seen.has(answer.requestId) ? ', an id already used' : '';
      return refused(`the decision is for request "${answer.requestId}"${used}, not "${pending.requestId}"`);
    }
    // Hashed again rather than trusted from before the wait: an input that changed while a human
    // was reading the prompt is not the input they decided on.
    let now: string;
    try {
      now = approvalRequestHash(ask);
    } catch (err) {
      return refused(`the request can no longer be hashed: ${messageOf(err)}`);
    }
    if (answer.requestHash !== pending.requestHash || now !== pending.requestHash) {
      return refused(
        `the decision is bound to hash ${answer.requestHash} but the request hashes to ${now}`,
      );
    }
    const reviewer = typeof answer.reviewer === 'string' && answer.reviewer !== '' ? answer.reviewer : 'unknown';
    const reason = typeof answer.reason === 'string' ? answer.reason : '';
    // Strictly `true`: a provider answering anything else has not approved.
    return answer.approved === true
      ? { status: 'Approved', reviewer, reason }
      : { status: 'Rejected', reviewer, reason };
  }

  private settle(ask: ApprovalAsk, requestId: string, requestHash: string, settlement: Settlement): ApprovalOutcome {
    const policyRuleId: unknown = ask.request?.policyRuleId;
    this.recorder.record({
      requestId, requestHash, ...settlement,
      toolId:        String(ask.toolId),
      policyRuleId:  typeof policyRuleId === 'string' ? policyRuleId : '',
      declaredPaths: Array.isArray(ask.declaredPaths) ? ask.declaredPaths : [],
      decidedAt:     new Date(),
    });
    return {
      approved: settlement.status === 'Approved',
      status: settlement.status, requestId, requestHash, reason: settlement.reason,
    };
  }
}

function refused(reason: string): Settlement {
  return { status: 'Rejected', reviewer: GATE, reason };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface TerminalStreams {
  input:  NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY:  boolean;
}

/** Why no one can be asked, or `undefined` when someone can (D-02: headless runs deny). */
export function headlessReason(terminal: { isTTY: boolean }, env: NodeJS.ProcessEnv): string | undefined {
  if (env['MAF_HEADLESS'] === '1') return 'MAF_HEADLESS=1 is set, so no one is asked';
  if (!terminal.isTTY) return 'stdin is not a terminal, so no one is asked';
  return undefined;
}

export interface CreateApprovalGateOptions {
  /** The run's `Attestor`, or anything with its `addApproval`. */
  recorder:   ApprovalSink;
  /** The project's `.maf` directory; headless requests are written under `approvals/pending/`. */
  mafDir:     string;
  /** Defaults to stdin (prompted on stderr). Tests pass streams. */
  terminal?:  TerminalStreams;
  env?:       NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The gate `maf run` uses: the terminal when there is one, the headless refusal when not. */
export function createApprovalGate(options: CreateApprovalGateOptions): ApprovalGate {
  // `isatty(0)` rather than `process.stdin.isTTY`: a headless run never touches stdin at all.
  const isTTY = options.terminal ? options.terminal.isTTY : tty.isatty(0);
  const why = headlessReason({ isTTY }, options.env ?? process.env);
  const provider = why !== undefined
    ? new HeadlessApprovalProvider({ pendingDir: path.join(options.mafDir, 'approvals', 'pending'), reason: why })
    : new TtyApprovalProvider(options.terminal ?? { input: process.stdin, output: process.stderr, isTTY });
  return new ApprovalGate({
    provider,
    recorder: options.recorder,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
