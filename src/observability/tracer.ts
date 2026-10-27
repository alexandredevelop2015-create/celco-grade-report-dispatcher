import { randomBytes } from 'node:crypto';
import { AppLogger } from './logger';

/**
 * Tracing simulado, no formato do OpenTelemetry (traceId/spanId/duração) mas emitido como log.
 * Trocar por `@opentelemetry/api` é mecânico: a interface de uso (`span(name, fn)`) é a mesma.
 */
export class Tracer {
  readonly traceId = randomBytes(16).toString('hex');

  constructor(private readonly logger: AppLogger) {}

  async span<T>(name: string, attrs: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
    const spanId = randomBytes(8).toString('hex');
    const start = Date.now();
    try {
      const result = await fn();
      this.logger.debug({ traceId: this.traceId, spanId, span: name, durationMs: Date.now() - start, ...attrs }, 'span');
      return result;
    } catch (error) {
      this.logger.debug(
        { traceId: this.traceId, spanId, span: name, durationMs: Date.now() - start, error: true, ...attrs },
        'span',
      );
      throw error;
    }
  }
}
