import type { SpawnResult } from './ProcessSpawner.js';

/** Enough of a failed backend's stderr or error body to show its last error. */
export const FAILURE_TAIL_CHARS = 300;

/**
 * Error messages are logged and kept in node state, and an authentication failure is exactly when
 * a backend echoes the key it was sent. These are the high-confidence credential formats from the
 * processors' redaction list, repeated because adapter-base may depend on @maf/types alone.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * The end of `text`, credential-shaped substrings masked, quoted so an empty or whitespace-only
 * tail is still visible. Masking runs over the whole text before the cut, so a key the cut would
 * split is still recognised.
 */
export function failureTail(text: string, chars: number = FAILURE_TAIL_CHARS): string {
  const masked = CREDENTIAL_SHAPES.reduce((s, re) => s.replace(re, '[REDACTED]'), text);
  return JSON.stringify(masked.length > chars ? `…${masked.slice(-chars)}` : masked);
}

/**
 * The stdout of a turn whose process finished cleanly. Parsed as a turn, the empty stdout of a
 * failed call reads as a final answer with no tool calls and ends the loop as completed (D-04), so
 * a turn that did not finish throws instead: a timeout or a silent exit rethrows the spawner's
 * TransportError, which the node may be retried on, and any other non-zero exit is the backend
 * reporting a failure — a plain Error, judged and not retried (D-06).
 */
export function turnStdout(adapter: string, result: SpawnResult): string {
  if (result.transportError !== undefined) throw result.transportError;
  if (result.exitCode !== 0) {
    throw new Error(
      `The ${adapter} adapter expected its turn to exit with code 0, but the process exited with `
      + `code ${result.exitCode}. stderr tail: ${failureTail(result.stderr)}`,
    );
  }
  return result.stdout;
}
