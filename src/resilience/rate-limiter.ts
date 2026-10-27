export interface RateLimiterOptions {
  ratePerSec: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Espaça as chamadas em 1/rate segundos. Como o Node é single-thread, reservar o próximo
 * slot de forma síncrona basta para ser seguro entre workers concorrentes do mesmo processo.
 * Entre processos o limite teria de ser compartilhado (ex.: token bucket no Redis).
 */
export class RateLimiter {
  private nextSlot = 0;
  private readonly interval: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RateLimiterOptions) {
    this.interval = options.ratePerSec > 0 ? 1000 / options.ratePerSec : 0;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async acquire(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.interval;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }
}
