import { DynamicModule, Module } from '@nestjs/common';
import { AppConfig } from './config/config';
import {
  AnalyticsSink,
  GradeSource,
  Notifier,
  RunStore,
  SummaryCache,
  SummaryGenerator,
  TOKENS,
} from './domain/ports';
import { CsvGradeSource } from './grades/csv-grade-source';
import { AnthropicSummaryGenerator } from './llm/anthropic-summary-generator';
import { BudgetGuard } from './llm/cost';
import { FakeSummaryGenerator } from './llm/fake-summary-generator';
import { ConsoleNotifier } from './notify/console-notifier';
import { ResendNotifier } from './notify/resend-notifier';
import { SmtpNotifier } from './notify/smtp-notifier';
import { FileAnalyticsSink } from './observability/analytics';
import { AppLogger, createLogger } from './observability/logger';
import { DispatcherService } from './pipeline/dispatcher.service';
import { StudentProcessor } from './pipeline/student-processor';
import { CircuitBreaker } from './resilience/circuit-breaker';
import { RateLimiter } from './resilience/rate-limiter';
import { JsonStateStore } from './store/json-state-store';
import { join } from 'node:path';

export interface AppOptions {
  config: AppConfig;
  csvPath: string;
  /** Nome do arquivo de estado dentro de OUTPUT_DIR (um por período). */
  statePath: string;
  /** Substitui o canal configurado (testes e integrações embarcadas). */
  notifier?: Notifier;
}

/**
 * Composition root. Todas as dependências externas entram por token (porta), então trocar
 * LLM, canal ou armazenamento é mudar um provider aqui, sem tocar no pipeline.
 */
@Module({})
export class AppModule {
  static register(options: AppOptions): DynamicModule {
    const { config } = options;

    return {
      module: AppModule,
      providers: [
        { provide: TOKENS.CONFIG, useValue: config },
        { provide: TOKENS.LOGGER, useFactory: () => createLogger(config.LOG_LEVEL) },
        {
          provide: TOKENS.GRADE_SOURCE,
          useFactory: (): GradeSource => new CsvGradeSource(options.csvPath, { scaleMax: config.GRADE_SCALE_MAX }),
        },
        {
          provide: TOKENS.SUMMARY_GENERATOR,
          useFactory: (): SummaryGenerator =>
            config.LLM_PROVIDER === 'anthropic'
              ? new AnthropicSummaryGenerator({
                  apiKey: config.ANTHROPIC_API_KEY!,
                  model: config.LLM_MODEL,
                  maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
                  timeoutMs: config.LLM_TIMEOUT_MS,
                })
              : new FakeSummaryGenerator({
                  failureRate: config.FAKE_LLM_FAILURE_RATE,
                  latencyMs: config.FAKE_LLM_LATENCY_MS,
                }),
        },
        {
          provide: TOKENS.NOTIFIER,
          useFactory: (): Notifier =>
            options.notifier ??
            (config.NOTIFIER === 'resend'
              ? new ResendNotifier({ apiKey: config.RESEND_API_KEY!, from: config.MAIL_FROM })
              : config.NOTIFIER === 'smtp'
              ? new SmtpNotifier({
                  host: config.SMTP_HOST,
                  port: config.SMTP_PORT,
                  user: config.SMTP_USER,
                  pass: config.SMTP_PASS,
                  from: config.MAIL_FROM,
                })
              : new ConsoleNotifier()),
        },
        { provide: 'STATE_STORE', useFactory: () => JsonStateStore.open(options.statePath) },
        { provide: TOKENS.RUN_STORE, useExisting: 'STATE_STORE' },
        {
          provide: TOKENS.SUMMARY_CACHE,
          useFactory: (store: JsonStateStore): SummaryCache => store.asCache(),
          inject: ['STATE_STORE'],
        },
        {
          provide: TOKENS.ANALYTICS,
          useFactory: (): AnalyticsSink => new FileAnalyticsSink(join(config.OUTPUT_DIR, 'events.ndjson')),
        },
        {
          provide: StudentProcessor,
          useFactory: (
            store: RunStore,
            cache: SummaryCache,
            generator: SummaryGenerator,
            notifier: Notifier,
            logger: AppLogger,
          ) =>
            new StudentProcessor({
              store,
              cache,
              generator,
              notifier,
              logger,
              llmBreaker: new CircuitBreaker({
                name: 'llm',
                failureThreshold: config.BREAKER_THRESHOLD,
                cooldownMs: config.BREAKER_COOLDOWN_MS,
              }),
              notifyBreaker: new CircuitBreaker({
                name: 'notifier',
                failureThreshold: config.BREAKER_THRESHOLD,
                cooldownMs: config.BREAKER_COOLDOWN_MS,
              }),
              llmLimiter: new RateLimiter({ ratePerSec: config.LLM_REQUESTS_PER_SEC }),
              notifyLimiter: new RateLimiter({
                ratePerSec: config.NOTIFIER === 'resend' ? Math.min(config.NOTIFY_RATE_PER_SEC, config.RESEND_REQUESTS_PER_SEC) : config.NOTIFY_RATE_PER_SEC,
              }),
              budget: new BudgetGuard(config.MAX_RUN_COST_USD),
              rules: { scaleMax: config.GRADE_SCALE_MAX, passMark: config.PASS_MARK },
              pricing: { inputPerMTok: config.LLM_PRICE_INPUT_PER_MTOK, outputPerMTok: config.LLM_PRICE_OUTPUT_PER_MTOK },
              maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
              fallbackOnLlmFailure: config.FALLBACK_ON_LLM_FAILURE,
              retry: {
                attempts: config.RETRY_ATTEMPTS,
                baseDelayMs: config.RETRY_BASE_MS,
                maxDelayMs: config.RETRY_MAX_MS,
              },
            }),
          inject: [TOKENS.RUN_STORE, TOKENS.SUMMARY_CACHE, TOKENS.SUMMARY_GENERATOR, TOKENS.NOTIFIER, TOKENS.LOGGER],
        },
        {
          provide: DispatcherService,
          useFactory: (source: GradeSource, processor: StudentProcessor, analytics: AnalyticsSink, logger: AppLogger) =>
            new DispatcherService(source, processor, analytics, logger),
          inject: [TOKENS.GRADE_SOURCE, StudentProcessor, TOKENS.ANALYTICS, TOKENS.LOGGER],
        },
      ],
      exports: [DispatcherService, TOKENS.SUMMARY_GENERATOR, TOKENS.NOTIFIER],
    };
  }
}
