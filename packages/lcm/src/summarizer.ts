// The shape every summarizer in this package answers with (WP-3.2, D-17).
//
// A summarizer is supplied by the run (in the CLI, the run's own adapter). It may answer with the
// summary text alone, or with the tokens the backend reported for the call so the summary's cost is
// recorded rather than guessed. The estimate (4 chars ≈ 1 token) is the fallback, exactly as it is
// for every other token count in this package.

import type { ModelSurface } from '@maf/types';

/**
 * The most characters one summarization prompt may carry (WP-3.2 F4).
 *
 * 64 KiB, because the binding limit is not the model's context but the operating system's: Linux
 * refuses to start a process whose single argv argument exceeds `MAX_ARG_STRLEN` (128 KiB), and a
 * backend that takes its prompt on the command line puts this string in exactly one argument. 64
 * KiB leaves the other half of that ceiling for the system prompt, the argv's own flags and the
 * shell's bookkeeping. The engine splits messages into segments beneath this cap and summarizes
 * the summaries upward, so a chunk is bounded before it reaches any adapter; this constant is the
 * one place the number lives, and the adapter also refuses a prompt over it.
 */
export const MAX_SUMMARY_PROMPT_CHARS = 64 * 1024;

export type SummaryOutput = string | {
  content: string;
  /** The backend's own count for the call, when it reports one (WP-3.2 F10). */
  tokensUsed?: number;
  /** What the call showed the model and what it returned (WP-3.2 F1). */
  surface?: ModelSurface;
  /** The model the call named, when it named one (WP-3.2 F1). */
  model?: string;
};

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
