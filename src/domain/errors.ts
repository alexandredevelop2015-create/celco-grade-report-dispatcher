/** Falha transitória (429, 5xx, timeout, rede): vale tentar de novo com backoff. */
export class RetriableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RetriableError';
  }
}

/** Falha permanente (400, 401, e-mail inválido): repetir só gasta dinheiro. */
export class FatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FatalError';
  }
}

/** Disjuntor aberto: falha rápida, sem tocar na dependência. */
export class CircuitOpenError extends Error {
  constructor(readonly dependency: string) {
    super(`Circuito aberto para ${dependency}`);
    this.name = 'CircuitOpenError';
  }
}

/** Orçamento da execução esgotado. */
export class BudgetExceededError extends Error {
  constructor(readonly limitUsd: number) {
    super(`Orçamento de ${limitUsd} USD esgotado`);
    this.name = 'BudgetExceededError';
  }
}

export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(
      `Esgotadas ${attempts} tentativas: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError },
    );
    this.name = 'RetryExhaustedError';
  }
}
