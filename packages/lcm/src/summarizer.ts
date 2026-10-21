// The shape every summarizer in this package answers with (WP-3.2, D-17).
//
// A summarizer is supplied by the run (in the CLI, the run's own adapter). It may answer with the
// summary text alone, or with the tokens the backend reported for the call so the summary's cost is
// recorded rather than guessed. The estimate (4 chars ≈ 1 token) is the fallback, exactly as it is
// for every other token count in this package.

import type { ModelSurface } from '@maf/types';

/**
 * The most bytes one summarization call's prompt may carry (WP-3.2 F4, R3).
 *
 * The binding limit is not the model's context but the operating system's: Linux refuses a process
 * whose single argv argument exceeds `MAX_ARG_STRLEN` (128 KiB), and a backend that takes its prompt
 * on the command line puts this string in exactly one argument. The verifier measured E2BIG at
 * about 150,000 bytes. The measure is bytes, not UTF-16 code units: one `'中'` is three bytes and
 * one code unit, so a character count let a 64 KiB prompt become ~192 KiB on the wire.
 *
 * 64 KiB for the prompt leaves half of that ceiling for the system prompt, the argv's own flags and
 * the shell's bookkeeping; {@link MAX_SUMMARY_ARGV_BYTES} states the whole-command-line budget and
 * {@link SUMMARY_ARGV_ALLOWANCE_BYTES} the part reserved for what the summarizer does not compose.
 */
export const MAX_SUMMARY_PROMPT_BYTES = 64 * 1024;
/** Everything the backend's command line carries, with ~22 KiB headroom under the measured E2BIG. */
export const MAX_SUMMARY_ARGV_BYTES = 128 * 1024;
/** Flags, the model name and the working directory: not the prompt, and not counted above. */
export const SUMMARY_ARGV_ALLOWANCE_BYTES = 8 * 1024;

/** Bytes on the wire, which is what the operating system's argument limit counts. */
export function byteLength(text: string): number { return Buffer.byteLength(text, 'utf8'); }

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
