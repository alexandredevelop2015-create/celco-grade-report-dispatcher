import { CircuitOpenError, FatalError, RetriableError, RetryExhaustedError } from '../src/domain/errors';
import { CircuitBreaker } from '../src/resilience/circuit-breaker';
import { runWithConcurrency } from '../src/resilience/concurrency';
import { RateLimiter } from '../src/resilience/rate-limiter';
import { withRetry } from '../src/resilience/retry';

describe('withRetry', () => {
  const base = { attempts: 4, baseDelayMs: 100, maxDelayMs: 1000 };

  it('repete erro retriável com backoff exponencial (jitter fixo em 1)', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 4) throw new RetriableError('503');
        return 'ok';
      },
      { ...base, random: () => 0.999999, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toEqual({ value: 'ok', attempts: 4 });
    expect(delays).toEqual([99, 199, 399]);
  });

  it('respeita Retry-After como piso do atraso', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls === 1) throw new RetriableError('429', 5000);
      },
      { ...base, random: () => 0, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([5000]);
  });

  it('não repete erro fatal', async () => {
    const fn = jest.fn().mockRejectedValue(new FatalError('401'));
    await expect(withRetry(fn, { ...base, sleep: async () => undefined })).rejects.toBeInstanceOf(FatalError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('não repete erro inesperado (bug)', async () => {
    const fn = jest.fn().mockRejectedValue(new TypeError('x is undefined'));
    await expect(withRetry(fn, { ...base, sleep: async () => undefined })).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('esgota as tentativas e informa quantas foram', async () => {
    const fn = jest.fn().mockRejectedValue(new RetriableError('503'));
    const error = await withRetry(fn, { ...base, sleep: async () => undefined }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect((error as RetryExhaustedError).attempts).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe('CircuitBreaker', () => {
  const failing = async () => {
    throw new RetriableError('503');
  };

  it('abre após o limiar, falha rápido e fecha com uma sonda bem-sucedida', async () => {
    let now = 0;
    const cb = new CircuitBreaker({ name: 'llm', failureThreshold: 2, cooldownMs: 1000, now: () => now });

    await expect(cb.exec(failing)).rejects.toBeInstanceOf(RetriableError);
    await expect(cb.exec(failing)).rejects.toBeInstanceOf(RetriableError);
    expect(cb.currentState).toBe('open');

    const dependency = jest.fn();
    await expect(cb.exec(dependency)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(dependency).not.toHaveBeenCalled();

    now = 1000;
    expect(cb.currentState).toBe('half-open');
    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    expect(cb.currentState).toBe('closed');
  });

  it('reabre se a sonda falhar', async () => {
    let now = 0;
    const cb = new CircuitBreaker({ name: 'llm', failureThreshold: 1, cooldownMs: 1000, now: () => now });
    await cb.exec(failing).catch(() => undefined);
    now = 1000;
    await cb.exec(failing).catch(() => undefined);
    expect(cb.currentState).toBe('open');
  });

  it('não conta erro fatal de dado como dependência doente', async () => {
    const cb = new CircuitBreaker({ name: 'llm', failureThreshold: 1, cooldownMs: 1000 });
    await cb.exec(async () => Promise.reject(new FatalError('400'))).catch(() => undefined);
    expect(cb.currentState).toBe('closed');
  });
});

describe('RateLimiter', () => {
  it('espaça as chamadas em 1/rate segundos', async () => {
    const waits: number[] = [];
    const rl = new RateLimiter({ ratePerSec: 10, now: () => 0, sleep: async (ms) => void waits.push(ms) });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(waits).toEqual([100, 200]);
  });
});

describe('runWithConcurrency', () => {
  it('nunca excede o limite e preserva a ordem dos resultados', async () => {
    let active = 0;
    let peak = 0;
    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });
});
