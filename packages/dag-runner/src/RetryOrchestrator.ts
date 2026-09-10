import type { RetryPolicy } from '@maf/types';

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === policy.maxAttempts) break;
      onRetry?.(attempt, err);
      const jitter    = Math.random() * policy.jitterMs;
      const backoffMs = policy.backoffMs * Math.pow(policy.backoffFactor, attempt - 1) + jitter;
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:  3,
  backoffMs:    1000,
  backoffFactor: 2,
  jitterMs:     500,
};
