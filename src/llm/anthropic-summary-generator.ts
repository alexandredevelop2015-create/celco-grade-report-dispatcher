import Anthropic from '@anthropic-ai/sdk';
import { FatalError, RetriableError } from '../domain/errors';
import { SummaryGenerator } from '../domain/ports';
import { GeneratedSummary, GradeProfile } from '../domain/types';
import { parseSummary } from './parse-summary';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

interface HttpLikeError {
  status?: number;
  headers?: Record<string, string | undefined> | { get(name: string): string | null };
  message?: string;
}

function retryAfterMs(error: HttpLikeError): number | undefined {
  const headers = error.headers;
  if (!headers) return undefined;
  const raw = 'get' in headers && typeof headers.get === 'function' ? headers.get('retry-after') : (headers as Record<string, string | undefined>)['retry-after'];
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Separa erro transitório de permanente:
 * - sem status (rede/timeout), 408, 409, 429, 5xx → retriável (respeitando Retry-After);
 * - 400/401/403/404/422 → fatal: repetir só gasta dinheiro e mascara config errada.
 */
export function classifyLlmError(error: unknown): Error {
  if (error instanceof RetriableError || error instanceof FatalError) return error;
  const http = (error ?? {}) as HttpLikeError;
  const message = http.message ?? 'erro desconhecido do provedor de LLM';
  const status = http.status;
  if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) {
    return new RetriableError(`LLM indisponível (${status ?? 'rede/timeout'}): ${message}`, retryAfterMs(http), {
      cause: error,
    });
  }
  return new FatalError(`LLM rejeitou o pedido (${status}): ${message}`, { cause: error });
}

export class AnthropicSummaryGenerator implements SummaryGenerator {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    // maxRetries 0: a política de retry é nossa (backoff, jitter, disjuntor, métricas).
    this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0, timeout: options.timeoutMs });
  }

  get model(): string {
    return this.options.model;
  }

  async generate(profile: GradeProfile): Promise<GeneratedSummary> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: this.options.maxOutputTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(profile) }],
      });
    } catch (error) {
      throw classifyLlmError(error);
    }

    const block = response.content.find((b) => b.type === 'text');
    const text = block && block.type === 'text' ? block.text : '';
    return {
      summary: parseSummary(text),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: this.options.model,
    };
  }
}
