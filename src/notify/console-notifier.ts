import { Notifier } from '../domain/ports';
import { NotificationMessage } from '../domain/types';
import { maskEmail } from '../grades/sanitize';

/** Notificador de demonstração: imprime o e-mail (com destinatário mascarado) em vez de enviar. */
export class ConsoleNotifier implements Notifier {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(l + '\n')) {}

  async send(message: NotificationMessage): Promise<void> {
    this.write(`--- ${message.idempotencyKey} -> ${maskEmail(message.to)} | ${message.subject}\n${message.text}\n`);
  }
}
