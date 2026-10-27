import { RetriableError, RetryExhaustedError } from '../domain/errors';

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Backoff exponencial com *full jitter* (evita rebanho trovejante quando muitos jobs
 * falham juntos). Só repete `RetriableError`; qualquer outra coisa sobe na hora:
 * `FatalError` porque repetir não adianta, erro inesperado porque é bug.
 * `retryAfterMs` (ex.: header Retry-After de um 429) vira piso do atraso.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      if (!(error instanceof RetriableError)) throw error;
      lastError = error;
      if (attempt === options.attempts) break;
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.max(Math.floor(random() * ceiling), error.retryAfterMs ?? 0);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new RetryExhaustedError(options.attempts, lastError);
}
