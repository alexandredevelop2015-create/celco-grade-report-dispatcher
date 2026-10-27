import { BudgetExceededError } from '../domain/errors';
import { TokenUsage } from '../domain/types';

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function estimateCostUsd(usage: TokenUsage, pricing: Pricing): number {
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

/** Heurística de ~4 caracteres por token, para prever custo antes de chamar. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Teto de gasto por execução. Falhar fechado: ao estourar, o resto do lote usa o fallback
 * determinístico em vez de continuar gastando. Reserva o custo *previsto* antes da chamada,
 * para que workers concorrentes não ultrapassem o teto em massa.
 */
export class BudgetGuard {
  private spent = 0;
  private reserved = 0;

  constructor(private readonly limitUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  reserve(estimatedUsd: number): () => void {
    if (this.spent + this.reserved + estimatedUsd > this.limitUsd) throw new BudgetExceededError(this.limitUsd);
    this.reserved += estimatedUsd;
    return () => {
      this.reserved -= estimatedUsd;
    };
  }

  commit(actualUsd: number): void {
    this.spent += actualUsd;
  }
}
