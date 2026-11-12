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
  /** R2-H4: how much of `tokens` the backend reported, and how much this side estimated. */
  reportedTokens?: number;
  estimatedTokens?: number;
  usd?: number;
  reportedUsd?: number;
  estimatedUsd?: number;
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

/**
 * R2-M1: a golden run is the expensive step, and a budget check that only looks at what has been
 * spent lets the run that crosses the ceiling start in the first place. Before each run the loop
 * projects `tasks × per-task cost` — the measured per-task cost of earlier runs in this session
 * where it has one, and this conservative figure where it does not (a real task is several role
 * turns and a tool loop over a small repo; the number is deliberately high so a projection errs
 * toward not starting).
 */
export const CONSERVATIVE_GOLDEN_TOKENS_PER_TASK = 8_000;

export interface GoldenRunProjection {
  tasks: number;
  perTaskTokens: number;
  source: 'measured' | 'conservative-estimate';
  projectedTokens: number;
  spentTokens: number;
  maxTokens: number;
  /** True when `spentTokens + projectedTokens` is over `maxTokens`. */
  exceeds: boolean;
  statement: string;
}

/** What earlier golden runs this session cost, if any: total tokens and total tasks measured. */
export interface GoldenRunMeasurement {
  tokens: number;
  tasks: number;
}

/**
 * R2-M1: project what one golden run will cost, before it starts. Returns undefined when no token
 * budget is set — there is nothing to cross — so a caller can treat undefined as "go ahead".
 */
export function projectGoldenRun(input: {
  tasks: number;
  spentTokens: number;
  maxTokens?: number | undefined;
  measured?: GoldenRunMeasurement | undefined;
}): GoldenRunProjection | undefined {
  const { tasks, spentTokens, maxTokens, measured } = input;
  if (maxTokens === undefined) return undefined;
  const fromMeasurement = measured !== undefined && measured.tasks > 0;
  const perTaskTokens = fromMeasurement
    ? measured.tokens / measured.tasks
    : CONSERVATIVE_GOLDEN_TOKENS_PER_TASK;
  const projectedTokens = Math.ceil(tasks * perTaskTokens);
  const exceeds = spentTokens + projectedTokens > maxTokens;
  const rounded = fromMeasurement ? `measured ${Math.round(perTaskTokens)}` : 'conservative estimate';
  return {
    tasks, perTaskTokens, source: fromMeasurement ? 'measured' : 'conservative-estimate',
    projectedTokens, spentTokens, maxTokens, exceeds,
    statement:
      `${tasks} task${tasks === 1 ? '' : 's'} × ${Math.round(perTaskTokens)} tokens each (${rounded}) `
      + `projects ${projectedTokens} tokens; ${spentTokens} already spent against a ${maxTokens}-token budget`
      + (exceeds ? ' — not started' : ' — inside the budget'),
  };
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
  reportedTokens = 0;
  estimatedTokens = 0;
  reportedUsd = 0;
  estimatedUsd = 0;

  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    readonly limits: EvolveBudgetLimits,
    opts: { startedAt?: number; now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
  }

  addTokens(n: number, source: 'reported' | 'estimated' = 'estimated'): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const tokens = Math.round(n);
    this.tokens += tokens;
    if (source === 'reported') this.reportedTokens += tokens;
    else this.estimatedTokens += tokens;
  }

  addUsd(n: number, source: 'reported' | 'estimated' = 'estimated'): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.usd += n;
    if (source === 'reported') this.reportedUsd += n;
    else this.estimatedUsd += n;
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
    // R2-H4: the token figure is the backend's report where it gave one and an estimate where it
    // did not; the split says which is which, so a reader can judge the number.
    if (maxTokens !== undefined)
      parts.push(`${this.tokens} of ${maxTokens} tokens (${this.reportedTokens} reported, ${this.estimatedTokens} estimated)`);
    if (maxUsd !== undefined)
      parts.push(`${dollars(this.usd)} of ${dollars(maxUsd)} (${dollars(this.reportedUsd)} reported, ${dollars(this.estimatedUsd)} estimated)`);
    const spent = parts.length > 0 ? parts.join(', ') : 'no budget was set';
    const statement = reason === undefined
      ? `budget: spent ${spent}`
      : `budget exhausted (${reason}): spent ${spent}`;

    return {
      limits: { ...this.limits },
      elapsedMs,
      tokens: this.tokens,
      reportedTokens: this.reportedTokens,
      estimatedTokens: this.estimatedTokens,
      ...(maxUsd !== undefined
        ? { usd: this.usd, reportedUsd: this.reportedUsd, estimatedUsd: this.estimatedUsd }
        : {}),
      exhausted: reason !== undefined,
      ...(reason !== undefined ? { reason } : {}),
      statement,
    };
  }
}
