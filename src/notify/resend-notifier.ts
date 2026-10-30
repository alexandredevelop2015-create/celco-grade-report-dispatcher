import { FatalError, RetriableError } from '../domain/errors';
import { Notifier } from '../domain/ports';
import { NotificationMessage } from '../domain/types';

export interface ResendOptions {
  apiKey: string;
  from: string;
  timeoutMs?: number;
  /** Injetável para testes; padrão: fetch global do Node. */
  fetchImpl?: typeof fetch;
}

interface ResendErrorBody {
  name?: string;
  message?: string;
}

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Traduz a resposta HTTP do Resend para o contrato de erros do pipeline:
 * - 429 (limite de taxa), 5xx e 409 `concurrent_idempotent_requests` → retriável (respeita Retry-After);
 * - 400/401/403/404/422 (chave inválida, remetente/domínio não verificado, e-mail inválido) e 409
 *   `invalid_idempotent_request` → fatal: repetir não resolve.
 * A mensagem nunca inclui a chave de API.
 */
export function classifyResendError(status: number, body: ResendErrorBody, retryAfterHeader?: string | null): Error {
  const detail = `Resend ${status}${body.name ? ` ${body.name}` : ''}: ${body.message ?? 'sem detalhe'}`;
  const seconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;

  if (status === 429 || status >= 500) return new RetriableError(detail, retryAfterMs);
  if (status === 409 && body.name === 'concurrent_idempotent_requests') return new RetriableError(detail, retryAfterMs);
  return new FatalError(detail);
}

/** Remove caracteres que quebrariam o formato `Nome <endereço>` do cabeçalho. */
const safeName = (name: string): string => name.replace(/[",<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();

export class ResendNotifier implements Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: NotificationMessage): Promise<void> {
    const name = safeName(message.toName);
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          // O Resend deduplica requisições com a mesma chave por 24h: um retry nunca vira e-mail duplicado.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [name ? `${name} <${message.to}>` : message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
      });
    } catch (error) {
      // Sem resposta (rede, DNS, timeout): transitório. Só o tipo do erro vai na mensagem.
      throw new RetriableError(`Falha de rede ao chamar o Resend (${(error as Error).name})`, undefined, { cause: error });
    }

    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as ResendErrorBody;
    throw classifyResendError(response.status, body, response.headers.get('retry-after'));
  }
}
