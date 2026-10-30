import { FatalError, RetriableError } from '../domain/errors';
import { Notifier } from '../domain/ports';
import { NotificationMessage } from '../domain/types';
import { maskPhone } from '../grades/sanitize';
import { AppLogger } from '../observability/logger';
import { RateLimiter } from '../resilience/rate-limiter';
import { RetryOptions, withRetry } from '../resilience/retry';

export interface WhatsappWebhookOptions {
  /** URL do webhook do n8n (workflow `n8n/boletim-whatsapp.json`). */
  url: string;
  /** Segredo compartilhado, enviado no header `x-webhook-secret`. */
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 429/5xx → retriável; 4xx (segredo errado, payload inválido, número rejeitado) → fatal. */
export function classifyWebhookError(status: number, retryAfterHeader?: string | null): Error {
  const detail = `Webhook WhatsApp respondeu ${status}`;
  const seconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
  return status === 429 || status >= 500 || status === 408 ? new RetriableError(detail, retryAfterMs) : new FatalError(detail);
}

/**
 * Envia a mensagem de WhatsApp chamando um workflow do n8n (que fala com o Evolution GO). O payload leva a
 * `idempotencyKey`: o n8n deduplica, então um retry nunca vira mensagem repetida. Sem telefone ou texto, não faz nada.
 */
export class WhatsappWebhookNotifier implements Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WhatsappWebhookOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: NotificationMessage): Promise<void> {
    if (!message.phone || !message.whatsappText) return;
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': message.idempotencyKey,
          ...(this.options.secret ? { 'x-webhook-secret': this.options.secret } : {}),
        },
        body: JSON.stringify({
          idempotencyKey: message.idempotencyKey,
          phone: message.phone,
          name: message.toName,
          text: message.whatsappText,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
      });
    } catch (error) {
      throw new RetriableError(`Falha de rede ao chamar o webhook do WhatsApp (${(error as Error).name})`, undefined, { cause: error });
    }
    if (!response.ok) throw classifyWebhookError(response.status, response.headers.get('retry-after'));
  }
}

export interface MultiChannelOptions {
  primary: Notifier;
  whatsapp: Notifier;
  limiter: RateLimiter;
  retry: RetryOptions;
  logger: AppLogger;
}

/**
 * E-mail é o canal oficial; WhatsApp é complemento em melhor esforço. O e-mail sai primeiro e, se falhar, a
 * falha sobe normalmente (o pipeline faz retry/breaker). O WhatsApp tem retry próprio e, esgotado, só registra
 * o aviso: a falha dele nunca invalida um e-mail já entregue, nem faz o e-mail ser reenviado.
 */
export class MultiChannelNotifier implements Notifier {
  constructor(private readonly options: MultiChannelOptions) {}

  async send(message: NotificationMessage): Promise<void> {
    await this.options.primary.send(message);
    if (!message.phone || !message.whatsappText) return;
    const { whatsapp, limiter, retry, logger } = this.options;
    try {
      await withRetry(async () => {
        await limiter.acquire();
        await whatsapp.send(message);
      }, retry);
    } catch (error) {
      logger.warn(
        { event: 'whatsapp_failed', key: message.idempotencyKey, phone: maskPhone(message.phone), err: error instanceof Error ? error.message : String(error) },
        'WhatsApp não enviado (o e-mail já foi entregue)',
      );
    }
  }
}
