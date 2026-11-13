/**
 * R2-H4: what an evolution run actually spent.
 *
 * Every model call the session makes goes through one seam — `invoke` (an opaque backend call) or
 * `sendTurn` (one turn of the in-process tool loop). `MeteredAdapter` wraps the run's adapter and
 * records every call it carries, so the planner, the critic, role turns, tool-loop turns, the
 * judge, the security gate and LCM summaries are all in the count, with the injected context each
 * turn carried. A backend that reports its usage is believed and the call is `reported`; where it
 * reports nothing the charge is `estimated` at ~4 characters per token over everything sent and
 * received — the conservative direction, so a budget stops early rather than late.
 */
import { estimateTokens, isTurnAdapter } from '@maf/types';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, AdapterName, AssistantTurn,
  CliAdapter, TurnAdapter, TurnMessage,
} from '@maf/types';

/** Where a figure came from: the backend's report, or this meter's bytes-based estimate. */
export type UsageSource = 'reported' | 'estimated';

/** One model call, kept so a caller can see what was charged and why. */
export interface UsageCall {
  /** Characters sent to the model — system prompt and history included. */
  sentChars: number;
  /** Characters received from the model. */
  receivedChars: number;
  tokens: number;
  source: UsageSource;
  /** The call's price, when one is known (reported by the backend, or estimated at the run's rate). */
  usd?: number;
  usdSource?: UsageSource;
}

export interface UsageSnapshot {
  /** Model calls the run made through the meter — every one, whatever asked for it. */
  calls: number;
  tokens: number;
  reportedTokens: number;
  estimatedTokens: number;
  reportedCalls: number;
  estimatedCalls: number;
  usd?: number;
  reportedUsd?: number;
  estimatedUsd?: number;
  /** One sentence for the report and the stop line: each figure marked reported or estimated. */
  statement: string;
}

function dollars(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return `$${Number(n.toFixed(6))}`;
  return `$${n.toFixed(4)}`;
}

/** Everything a turn sent, as text: the system block, every message, and the tool catalogue. */
function turnText(history: readonly TurnMessage[], options: AdapterInvokeOptions): string {
  const messages = history.map((m) => {
    if (m.kind === 'tool') return `${m.toolName} (${m.toolUseId}): ${m.content}`;
    if (m.kind === 'assistant') return `${m.text}\n${JSON.stringify(m.toolCalls)}`;
    return m.text;
  });
  const tools = options.tools === undefined ? '' : JSON.stringify(options.tools.map((t) => t.id));
  return `${options.systemPrompt ?? ''}\n${tools}\n${messages.join('\n')}`;
}

export class UsageMeter {
  readonly calls: UsageCall[] = [];

  /** @param usdPerMillionTokens — the run's price, when it has one, so an estimate can also be priced. */
  constructor(private readonly usdPerMillionTokens?: number) {}

  record(
    sent: string, received: string,
    reported: { tokens?: number; costUsd?: number } = {},
  ): UsageCall {
    const reportedTokens = reported.tokens !== undefined && Number.isFinite(reported.tokens) && reported.tokens > 0
      ? Math.round(reported.tokens)
      : undefined;
    const tokens = reportedTokens ?? estimateTokens(sent) + estimateTokens(received);
    const costUsd = reported.costUsd !== undefined && Number.isFinite(reported.costUsd) && reported.costUsd > 0
      ? reported.costUsd
      : undefined;
    const usd = costUsd
      ?? (this.usdPerMillionTokens !== undefined ? (tokens * this.usdPerMillionTokens) / 1_000_000 : undefined);
    const call: UsageCall = {
      sentChars: sent.length,
      receivedChars: received.length,
      tokens,
      source: reportedTokens !== undefined ? 'reported' : 'estimated',
      ...(usd !== undefined ? { usd, usdSource: costUsd !== undefined ? 'reported' as const : 'estimated' as const } : {}),
    };
    this.calls.push(call);
    return call;
  }

  snapshot(): UsageSnapshot {
    const reported = this.calls.filter((c) => c.source === 'reported');
    const estimated = this.calls.filter((c) => c.source === 'estimated');
    const reportedTokens = reported.reduce((n, c) => n + c.tokens, 0);
    const estimatedTokens = estimated.reduce((n, c) => n + c.tokens, 0);
    const priced = this.calls.filter((c) => c.usd !== undefined);
    const reportedUsd = priced.filter((c) => c.usdSource === 'reported').reduce((n, c) => n + (c.usd ?? 0), 0);
    const estimatedUsd = priced.filter((c) => c.usdSource === 'estimated').reduce((n, c) => n + (c.usd ?? 0), 0);
    const usd = priced.length > 0 ? reportedUsd + estimatedUsd : undefined;

    const tokensPart = `${reportedTokens + estimatedTokens} tokens (${reportedTokens} reported, ${estimatedTokens} estimated)`;
    const usdPart = usd === undefined || priced.length === 0
      ? ''
      : `, ${dollars(usd)} (${dollars(reportedUsd)} reported, ${dollars(estimatedUsd)} estimated)`;
    return {
      calls: this.calls.length,
      tokens: reportedTokens + estimatedTokens,
      reportedTokens,
      estimatedTokens,
      reportedCalls: reported.length,
      estimatedCalls: estimated.length,
      ...(usd !== undefined ? { usd, reportedUsd, estimatedUsd } : {}),
      statement: `usage: ${this.calls.length} model call${this.calls.length === 1 ? '' : 's'}; ${tokensPart}${usdPart}`,
    };
  }
}

type OnCall = (call: UsageCall) => void;

/** The metering seam for an adapter that only answers `invoke`. */
class MeteringCliAdapter implements CliAdapter {
  constructor(
    protected readonly inner: CliAdapter,
    protected readonly meter: UsageMeter,
    protected readonly onCall: OnCall | undefined,
  ) {}

  get name(): AdapterName { return this.inner.name; }
  capabilities(): AdapterCapabilities { return this.inner.capabilities(); }
  isAvailable(): Promise<boolean> { return this.inner.isAvailable(); }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const result = await this.inner.invoke({ ...options, reportUsage: true });
    this.charge(
      `${options.systemPrompt ?? ''}\n${JSON.stringify(options.tools ?? [])}\n${options.prompt}`,
      result.output,
      result.tokensUsed, result.costUsd,
    );
    return result;
  }

  stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    // A stream has no totals to read and no answer to unwrap; it is passed through untouched. The
    // evolution loop does not stream, so no spend escapes the count today.
    return this.inner.stream({ ...options, reportUsage: true });
  }

  protected charge(sent: string, received: string, tokens: number | undefined, costUsd: number | undefined): void {
    const call = this.meter.record(sent, received, {
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
    this.onCall?.(call);
  }
}

/** The metering seam for an adapter the in-process tool loop can drive: one charge per turn. */
class MeteringTurnAdapter extends MeteringCliAdapter implements TurnAdapter {
  async sendTurn(history: TurnMessage[], options: AdapterInvokeOptions): Promise<AssistantTurn> {
    // R2-M2: like `invoke`, a role turn asks for the backend's own usage. An adapter that cannot
    // report one ignores the flag (the adapter contract) and the call stays an estimate.
    const result = await (this.inner as TurnAdapter).sendTurn(history, { ...options, reportUsage: true });
    this.charge(
      turnText(history, options),
      `${result.text}\n${JSON.stringify(result.toolCalls)}${result.raw ?? ''}`,
      // R3-L2: a turn that reports a cost is charged that cost, marked `reported`, the same way a
      // single `invoke` call is; only a turn with no figure falls back to the run's price.
      result.tokensUsed, result.costUsd,
    );
    return result;
  }
}

/**
 * Wrap an adapter so every call it carries is counted. The returned value keeps the adapter's
 * `sendTurn` only when the inner one has it, because the dispatcher uses that to choose the tier.
 */
export function meterAdapter(inner: CliAdapter, meter: UsageMeter, onCall?: OnCall): CliAdapter {
  return isTurnAdapter(inner)
    ? new MeteringTurnAdapter(inner, meter, onCall)
    : new MeteringCliAdapter(inner, meter, onCall);
}
