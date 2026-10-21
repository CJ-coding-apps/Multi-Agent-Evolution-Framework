// The shape every summarizer in this package answers with (WP-3.2, D-17).
//
// A summarizer is supplied by the run (in the CLI, the run's own adapter). It may answer with the
// summary text alone, or with the tokens the backend reported for the call so the summary's cost is
// recorded rather than guessed. The estimate (4 chars ≈ 1 token) is the fallback, exactly as it is
// for every other token count in this package.

export type SummaryOutput = string | { content: string; tokensUsed?: number };

/** 4 chars ≈ 1 token — the package's one estimate, so a summary and a message agree. */
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

export function summaryContent(output: SummaryOutput): string {
  if (typeof output === 'string') return output;
  if (typeof output?.content !== 'string') {
    throw new Error('A summarizer must return a string or an object with a string `content`.');
  }
  return output.content;
}

export function summaryTokens(output: SummaryOutput, content = summaryContent(output)): number {
  if (typeof output !== 'string' && typeof output?.tokensUsed === 'number' && Number.isFinite(output.tokensUsed) && output.tokensUsed >= 0) {
    return Math.ceil(output.tokensUsed);
  }
  return estimateTokens(content);
}
