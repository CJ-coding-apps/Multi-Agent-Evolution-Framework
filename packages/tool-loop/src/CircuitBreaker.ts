import type { CircuitBreakerConfig } from '@maf/types';

export class CircuitBreakerError extends Error {
  constructor(public readonly reason: 'maxAttempts' | 'maxErrors' | 'tokenBudget' | 'rateLimit') {
    super(`Circuit breaker tripped: ${reason}`);
  }
}

export class CircuitBreaker {
  private attempts   = 0;
  private errors     = 0;
  private tokensUsed = 0;
  private callTimes: number[] = [];

  constructor(private readonly config: CircuitBreakerConfig) {}

  check(): void {
    if (this.attempts >= this.config.maxAttempts) throw new CircuitBreakerError('maxAttempts');
    if (this.errors  >= this.config.maxErrors)    throw new CircuitBreakerError('maxErrors');
    if (this.tokensUsed >= this.config.tokenBudget) throw new CircuitBreakerError('tokenBudget');
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000; // 1 hour window
    this.callTimes = this.callTimes.filter((t) => t > windowStart);
    if (this.callTimes.length >= this.config.callsPerHour) throw new CircuitBreakerError('rateLimit');
  }

  recordAttempt(): void { this.attempts++; this.callTimes.push(Date.now()); }
  recordError():   void { this.errors++; }
  recordTokens(n: number): void { this.tokensUsed += n; }

  reset(): void { this.attempts = 0; this.errors = 0; }

  stats(): { attempts: number; errors: number; tokensUsed: number } {
    return { attempts: this.attempts, errors: this.errors, tokensUsed: this.tokensUsed };
  }
}
