import type { RetryPolicy } from '@maf/types';
import { TransportError } from '@maf/types';
import { describeValue, isPositiveSafeInteger } from './validateDag.js';

/**
 * Runs `fn`, and runs it again only when it failed with a `TransportError` (D-06).
 *
 * Every other error — a gate refusal, a policy denial, a bug — propagates after the first
 * attempt. Retrying those is how a security-gate rejection used to get a second roll: the
 * retry wraps the whole executor, gates included, so attempt 2 could pass what attempt 1
 * refused. Classification is opt-in by type, so an error nobody classified is not retried.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  // A policy allowing no attempt used to skip the loop and `throw undefined`: the node failed
  // without running, with nothing to say why.
  if (!isPositiveSafeInteger(policy.maxAttempts)) {
    throw new RangeError(
      `Retry policy maxAttempts must be a positive safe integer (1 means no retry), ` +
      `got ${describeValue(policy.maxAttempts)}.`,
    );
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof TransportError) || attempt >= policy.maxAttempts) throw err;
      onRetry?.(attempt, err);
      const jitter    = Math.random() * policy.jitterMs;
      const backoffMs = policy.backoffMs * Math.pow(policy.backoffFactor, attempt - 1) + jitter;
      await sleep(backoffMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Two attempts: one retry is enough to ride out a dropped connection or a stalled process,
// and every further attempt re-runs an agent that may already have changed the tree.
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:  2,
  backoffMs:    1000,
  backoffFactor: 2,
  jitterMs:     500,
};
