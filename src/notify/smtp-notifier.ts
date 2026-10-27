import { createTransport, Transporter } from 'nodemailer';
import { FatalError, RetriableError } from '../domain/errors';
import { Notifier } from '../domain/ports';
import { NotificationMessage } from '../domain/types';

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

interface SmtpLikeError {
  code?: string;
  responseCode?: number;
  message?: string;
}

/**
 * SMTP 4xx e falhas de rede são transitórias; 5xx e envelope inválido são permanentes
 * (caixa inexistente, rejeição): repetir não resolve e só queima reputação do remetente.
 */
export function classifySmtpError(error: unknown): Error {
  const e = (error ?? {}) as SmtpLikeError;
  const message = e.message ?? 'erro SMTP desconhecido';
  if (e.code === 'EENVELOPE') return new FatalError(`Endereço rejeitado: ${message}`, { cause: error });
  if (e.responseCode !== undefined) {
    return e.responseCode >= 500
      ? new FatalError(`SMTP ${e.responseCode}: ${message}`, { cause: error })
      : new RetriableError(`SMTP ${e.responseCode}: ${message}`, undefined, { cause: error });
  }
  return new RetriableError(`Falha de rede SMTP (${e.code ?? 'sem código'}): ${message}`, undefined, { cause: error });
}

export class SmtpNotifier implements Notifier {
  private readonly transport: Transporter;

  constructor(private readonly options: SmtpOptions) {
    this.transport = createTransport({
      host: options.host,
      port: options.port,
      secure: false,
      pool: true,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
    });
  }

  async send(message: NotificationMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.options.from,
        to: { name: message.toName.replace(/[",<>]/g, ''), address: message.to },
        subject: message.subject,
        text: message.text,
        html: message.html,
        // Mesmo Message-ID em reenvios: o destino consegue deduplicar o que escapar do nosso controle.
        messageId: `<${message.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '.')}@boletim.local>`,
      });
    } catch (error) {
      throw classifySmtpError(error);
    }
  }
}
