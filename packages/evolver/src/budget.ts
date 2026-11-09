/**
 * D-57: a wall-clock, token and dollar budget bound the evolution loop, and the report states what
 * was spent. The loop cannot meter spend itself — the money is spent by the adapter calls the caller
 * wires (`metaGenerate`, the golden runner) — so the caller feeds a meter and the loop asks it
 * before every step that costs anything. `EvolveBudget` is that meter, here so the arithmetic and
 * the sentence that reports it live in one place and are testable without a model.
 */

export interface EvolveBudgetLimits {
  /** Wall-clock ceiling for the whole run. */
  maxWallClockMs?: number;
  /** Token ceiling. The caller feeds estimated or measured usage; which one is the caller's call. */
  maxTokens?: number;
  /** Dollar ceiling. Only meaningful when the caller can price tokens (a rate was supplied). */
  maxUsd?: number;
}

export interface BudgetSnapshot {
  limits: EvolveBudgetLimits;
  elapsedMs: number;
  tokens: number;
  usd?: number;
  /** True when a configured limit is reached or passed. An unset limit never trips. */
  exhausted: boolean;
  /** The first limit that tripped, in the order wall-clock, tokens, dollars. */
  reason?: 'wall-clock' | 'tokens' | 'usd';
  /** One sentence an operator can read: what was spent against what, and what stopped it. */
  statement: string;
}

export interface BudgetMeter {
  snapshot(): BudgetSnapshot;
}

function human(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

/** Cents for ordinary money; a sub-cent budget or spend keeps its significant digits ($0.001, not $0.00). */
function dollars(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return `$${Number(n.toFixed(6))}`;
  return `$${n.toFixed(2)}`;
}

/**
 * A meter the caller owns and feeds. `now` is injectable so a test can move the clock instead of
 * waiting; `startedAt` lets a caller that has already spent (resolving adapters, loading a policy)
 * count that spend.
 */
export class EvolveBudget implements BudgetMeter {
  tokens = 0;
  usd = 0;

  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    readonly limits: EvolveBudgetLimits,
    opts: { startedAt?: number; now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
  }

  addTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.tokens += Math.round(n);
  }

  addUsd(n: number): void {
    if (Number.isFinite(n) && n > 0) this.usd += n;
  }

  snapshot(): BudgetSnapshot {
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    const { maxWallClockMs, maxTokens, maxUsd } = this.limits;
    let reason: BudgetSnapshot['reason'];
    if (maxWallClockMs !== undefined && elapsedMs >= maxWallClockMs) reason = 'wall-clock';
    else if (maxTokens !== undefined && this.tokens >= maxTokens) reason = 'tokens';
    else if (maxUsd !== undefined && this.usd >= maxUsd) reason = 'usd';

    const parts: string[] = [];
    if (maxWallClockMs !== undefined) parts.push(`${human(elapsedMs)} of ${human(maxWallClockMs)} wall-clock`);
    if (maxTokens !== undefined) parts.push(`${this.tokens} of ${maxTokens} tokens`);
    if (maxUsd !== undefined) parts.push(`${dollars(this.usd)} of ${dollars(maxUsd)}`);
    const spent = parts.length > 0 ? parts.join(', ') : 'no budget was set';
    const statement = reason === undefined
      ? `budget: spent ${spent}`
      : `budget exhausted (${reason}): spent ${spent}`;

    return {
      limits: { ...this.limits },
      elapsedMs,
      tokens: this.tokens,
      ...(maxUsd !== undefined ? { usd: this.usd } : {}),
      exhausted: reason !== undefined,
      ...(reason !== undefined ? { reason } : {}),
      statement,
    };
  }
}
