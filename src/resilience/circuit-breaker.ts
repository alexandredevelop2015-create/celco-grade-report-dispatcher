import { CircuitOpenError, RetriableError, RetryExhaustedError } from '../domain/errors';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

/**
 * Abre após N falhas *transitórias* consecutivas; depois do cooldown deixa passar uma
 * sonda (half-open). Erros fatais de dado (ex.: 400) não contam: não indicam dependência doente.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';
  private probing = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.cooldownMs) return 'half-open';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === 'open' || (state === 'half-open' && this.probing)) {
      throw new CircuitOpenError(this.options.name);
    }
    const isProbe = state === 'half-open';
    if (isProbe) this.probing = true;

    try {
      const value = await fn();
      this.failures = 0;
      this.state = 'closed';
      return value;
    } catch (error) {
      if (error instanceof RetriableError || error instanceof RetryExhaustedError) {
        this.failures++;
        if (isProbe || this.failures >= this.options.failureThreshold) {
          this.state = 'open';
          this.openedAt = this.now();
        }
      }
      throw error;
    } finally {
      if (isProbe) this.probing = false;
    }
  }
}
