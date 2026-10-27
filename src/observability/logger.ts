import pino, { Logger } from 'pino';

export type AppLogger = Logger;

/**
 * Logs estruturados (JSON, uma linha por evento). `redact` é a rede de segurança: mesmo que alguém
 * passe e-mail/nome/segredo num objeto de log, o valor sai como [Redacted]. Boa prática continua sendo
 * nem passar: o código loga só `studentId`, status e durações.
 */
export function createLogger(level: string): AppLogger {
  return pino({
    level,
    base: { service: 'grade-dispatcher' },
    redact: {
      paths: ['email', 'name', 'to', 'toName', '*.email', '*.name', 'apiKey', '*.apiKey', 'pass', '*.pass'],
      censor: '[Redacted]',
    },
  });
}
