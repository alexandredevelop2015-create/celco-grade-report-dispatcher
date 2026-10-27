import { RetriableError } from '../domain/errors';
import { SummaryGenerator } from '../domain/ports';
import { GeneratedSummary, GradeProfile } from '../domain/types';
import { estimateTokens } from './cost';
import { buildFallbackSummary } from './fallback-summary';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';

export interface FakeOptions {
  failureRate?: number;
  latencyMs?: number;
  random?: () => number;
}

/**
 * Implementação determinística do contrato `SummaryGenerator`: roda a demo e os testes sem chave
 * nem custo, e permite injetar falhas/latência para exercitar retry e circuit breaker.
 */
export class FakeSummaryGenerator implements SummaryGenerator {
  readonly model = 'fake-model';
  calls = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  async generate(profile: GradeProfile): Promise<GeneratedSummary> {
    this.calls++;
    const random = this.options.random ?? Math.random;
    if (this.options.latencyMs) await new Promise((r) => setTimeout(r, this.options.latencyMs));
    if (random() < (this.options.failureRate ?? 0)) throw new RetriableError('Falha simulada (HTTP 503)');

    const summary = buildFallbackSummary(profile);
    return {
      summary,
      usage: {
        inputTokens: estimateTokens(SYSTEM_PROMPT + buildUserPrompt(profile)),
        outputTokens: estimateTokens(JSON.stringify(summary)),
      },
      model: this.model,
    };
  }
}
