import {
  BudgetExceededError,
  CircuitOpenError,
  FatalError,
  RetriableError,
  RetryExhaustedError,
} from '../domain/errors';
import { Notifier, RunStore, SummaryCache, SummaryGenerator } from '../domain/ports';
import {
  ErrorKind,
  GradeChange,
  GradeEntry,
  GradeProfile,
  NotificationMessage,
  StudentGrades,
  StudentRecord,
  SummarySource,
  SummaryText,
  TokenUsage,
} from '../domain/types';
import { buildProfile, diffGrades, profileCacheKey, studentDataHash, AcademicRules } from '../grades/profile';
import { BudgetGuard, estimateCostUsd, estimateTokens, Pricing } from '../llm/cost';
import { buildFallbackSummary } from '../llm/fallback-summary';
import { buildUserPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from '../llm/prompt';
import { renderBulletin, renderRemoval } from '../notify/render-bulletin';
import { AppLogger } from '../observability/logger';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { RateLimiter } from '../resilience/rate-limiter';
import { RetryOptions, withRetry } from '../resilience/retry';

export interface RunContext {
  runId: string;
  period: string;
  traceId: string;
}

export interface StudentOutcome {
  studentId: string;
  status: 'sent' | 'skipped' | 'failed';
  /** true quando reenviou um boletim já enviado porque as notas mudaram (ou por --resend). */
  updated?: boolean;
  /** Tipo do lançamento, para a planilha de alterações. */
  kind?: 'novo' | 'atualizado' | 'reenvio' | 'removido';
  studentName: string;
  /** Disciplinas novas/alteradas em relação ao último boletim enviado. */
  changes?: GradeChange[];
  source?: SummarySource;
  usage: TokenUsage;
  costUsd: number;
  llmAttempts: number;
  durationMs: number;
  error?: { kind: ErrorKind; message: string };
}

export interface ProcessorDeps {
  store: RunStore;
  cache: SummaryCache;
  generator: SummaryGenerator;
  notifier: Notifier;
  llmBreaker: CircuitBreaker;
  notifyBreaker: CircuitBreaker;
  llmLimiter: RateLimiter;
  notifyLimiter: RateLimiter;
  budget: BudgetGuard;
  logger: AppLogger;
  rules: AcademicRules;
  pricing: Pricing;
  maxOutputTokens: number;
  fallbackOnLlmFailure: boolean;
  retry: Omit<RetryOptions, 'onRetry'>;
  now?: () => number;
}

interface Obtained {
  summary: SummaryText;
  source: SummarySource;
  usage: TokenUsage;
  costUsd: number;
  attempts: number;
  degradedBy?: { kind: ErrorKind; message: string };
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export function toErrorInfo(error: unknown): { kind: ErrorKind; message: string } {
  if (error instanceof CircuitOpenError) return { kind: 'circuit_open', message: error.message };
  if (error instanceof BudgetExceededError) return { kind: 'budget', message: error.message };
  if (error instanceof RetryExhaustedError) return { kind: 'retriable_exhausted', message: error.message };
  if (error instanceof FatalError) return { kind: 'fatal', message: error.message };
  if (error instanceof RetriableError) return { kind: 'retriable_exhausted', message: error.message };
  return { kind: 'unexpected', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Processa UM aluno de ponta a ponta e é idempotente por `(runId, studentId)`:
 *   SENT      -> pula (reexecução não reenvia);
 *   GENERATED -> reaproveita o resumo salvo e só tenta o envio (não paga o LLM duas vezes);
 *   FAILED/sem registro -> processa do início.
 * O resumo é persistido ANTES do envio, justamente para o retry de envio não custar LLM de novo.
 */
export class StudentProcessor {
  private readonly now: () => number;

  constructor(private readonly deps: ProcessorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async process(ctx: RunContext, student: StudentGrades, options: { forceResend?: boolean } = {}): Promise<StudentOutcome> {
    const started = this.now();
    const log = this.deps.logger.child({ runId: ctx.runId, traceId: ctx.traceId, studentId: student.studentId });
    const elapsed = () => this.now() - started;

    const existing = await this.deps.store.get(ctx.runId, student.studentId);
    const dataHash = studentDataHash(student);
    // Registros antigos (sem hash) são tratados como "sem mudança" para não reenviar tudo após uma atualização.
    const dataChanged = existing?.dataHash !== undefined && existing.dataHash !== dataHash;
    const alreadySent = existing?.status === 'SENT';
    // Já houve um boletim entregue? Vale também para quem teve a atualização anterior falhada (FAILED).
    const wasDelivered = alreadySent || existing?.lastSentGrades !== undefined;
    const updated = wasDelivered && (dataChanged || options.forceResend === true || !alreadySent);
    const changes = updated
      ? existing?.lastSentGrades
        ? diffGrades(existing.lastSentGrades, student.grades)
        : []
      : diffGrades(undefined, student.grades);
    const kind: StudentOutcome['kind'] = !updated ? 'novo' : changes.length ? 'atualizado' : 'reenvio';
    const base = { studentId: student.studentId, studentName: student.name };
    if (alreadySent && !dataChanged && options.forceResend !== true) {
      log.info({ event: 'student_skipped' }, 'já enviado e sem alterações, ignorado (idempotência)');
      return { ...base, status: 'skipped', usage: NO_USAGE, costUsd: 0, llmAttempts: 0, durationMs: elapsed() };
    }

    const profile = buildProfile(student, this.deps.rules);
    let obtained: Obtained | undefined;
    // Resumo de fallback não é reaproveitado: na retomada o LLM pode já ter voltado.
    // E só vale se as notas não mudaram: nota nova pede texto novo.
    const reusable = existing?.summary && existing.summarySource !== 'fallback' && !dataChanged ? existing : undefined;

    try {
      obtained = reusable?.summary
        ? {
            summary: reusable.summary,
            source: reusable.summarySource ?? 'llm',
            usage: NO_USAGE,
            costUsd: 0,
            attempts: 0,
          }
        : await this.obtainSummary(profile, log);

      if (!reusable?.summary) {
        await this.deps.store.put(ctx.runId, this.record(student, dataHash, 'GENERATED', obtained, undefined, existing?.lastSentGrades));
      }

      await this.send(ctx, student, profile, obtained.summary, dataHash, updated, changes, log);
      await this.deps.store.put(ctx.runId, this.record(student, dataHash, 'SENT', obtained, undefined, student.grades));

      log.info(
        { event: 'student_sent', updated, source: obtained.source, costUsd: obtained.costUsd, durationMs: elapsed() },
        updated ? 'boletim atualizado reenviado' : 'boletim enviado',
      );
      return {
        ...base,
        status: 'sent',
        updated,
        kind,
        changes,
        source: obtained.source,
        usage: obtained.usage,
        costUsd: obtained.costUsd,
        llmAttempts: obtained.attempts,
        durationMs: elapsed(),
        error: obtained.degradedBy,
      };
    } catch (error) {
      const info = toErrorInfo(error);
      // Fatal/inesperado merecem `error`; falha transitória esgotada é esperada em incidente: `warn`.
      const level = info.kind === 'unexpected' ? 'error' : 'warn';
      log[level]({ event: 'student_failed', kind: info.kind, err: info.message, durationMs: elapsed() }, 'falha ao processar aluno');
      await this.deps.store
        .put(ctx.runId, this.record(student, dataHash, 'FAILED', obtained, info, existing?.lastSentGrades))
        .catch((e: unknown) => log.error({ err: String(e) }, 'não consegui gravar o estado FAILED'));
      return {
        ...base,
        status: 'failed',
        updated,
        kind,
        changes,
        source: obtained?.source,
        usage: obtained?.usage ?? NO_USAGE,
        costUsd: obtained?.costUsd ?? 0,
        llmAttempts: obtained?.attempts ?? 0,
        durationMs: elapsed(),
        error: info,
      };
    }
  }

  /**
   * Alunos que já receberam boletim neste período mas NÃO aparecem mais no CSV (linha apagada).
   * `deliveredTotal` serve à trava de segurança: apagar quase tudo costuma ser arquivo errado.
   */
  async findRemovals(runId: string, seenIds: ReadonlySet<string>): Promise<{ candidates: StudentRecord[]; deliveredTotal: number }> {
    const records = await this.deps.store.list(runId);
    const delivered = records.filter((r) => r.status === 'SENT' || r.lastSentGrades !== undefined);
    return { candidates: delivered.filter((r) => !seenIds.has(r.studentId)), deliveredTotal: delivered.length };
  }

  /** Avisa o aluno de que o lançamento foi removido e marca o registro como REMOVED (se ele voltar, será "novo"). */
  async processRemoval(ctx: RunContext, record: StudentRecord): Promise<StudentOutcome | undefined> {
    const started = this.now();
    const log = this.deps.logger.child({ runId: ctx.runId, traceId: ctx.traceId, studentId: record.studentId });
    if (!record.email || !record.name) {
      log.warn({ event: 'removal_no_contact' }, 'lançamento removido, mas o registro é antigo e não guardou o e-mail: não deu para avisar');
      return undefined;
    }
    const previous = record.lastSentGrades ?? [];
    const base = {
      studentId: record.studentId,
      studentName: record.name,
      kind: 'removido' as const,
      changes: previous.map((g) => ({ subject: g.subject, before: g.grade })),
      usage: NO_USAGE,
      costUsd: 0,
      llmAttempts: 0,
    };
    try {
      const message = renderRemoval({ runId: ctx.runId, period: ctx.period, studentId: record.studentId, name: record.name, email: record.email, previous });
      await this.deliver(message, log);
      await this.deps.store.put(ctx.runId, {
        studentId: record.studentId,
        status: 'REMOVED',
        attempts: record.attempts,
        name: record.name,
        email: record.email,
        updatedAt: new Date(this.now()).toISOString(),
      });
      log.info({ event: 'student_removal_sent' }, 'aviso de lançamento removido enviado');
      return { ...base, status: 'sent', durationMs: this.now() - started };
    } catch (error) {
      const info = toErrorInfo(error);
      log.warn({ event: 'student_failed', kind: info.kind, err: info.message }, 'falha ao avisar remoção');
      return { ...base, status: 'failed', error: info, durationMs: this.now() - started };
    }
  }

  private record(
    student: StudentGrades,
    dataHash: string,
    status: StudentRecord['status'],
    obtained: Obtained | undefined,
    error?: StudentRecord['error'],
    lastSentGrades?: GradeEntry[],
  ): StudentRecord {
    return {
      studentId: student.studentId,
      status,
      dataHash,
      name: student.name,
      email: student.email,
      lastSentGrades,
      attempts: obtained?.attempts ?? 0,
      summary: obtained?.summary,
      summarySource: obtained?.source,
      error,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async obtainSummary(profile: GradeProfile, log: AppLogger): Promise<Obtained> {
    const d = this.deps;
    const key = profileCacheKey(profile, d.generator.model, PROMPT_VERSION);

    const cached = await d.cache.get(key);
    if (cached) return { summary: cached, source: 'cache', usage: NO_USAGE, costUsd: 0, attempts: 0 };

    try {
      const estimate = estimateCostUsd(
        { inputTokens: estimateTokens(SYSTEM_PROMPT + buildUserPrompt(profile)), outputTokens: d.maxOutputTokens },
        d.pricing,
      );
      const release = d.budget.reserve(estimate);
      try {
        const { value, attempts } = await withRetry(
          () =>
            d.llmBreaker.exec(async () => {
              await d.llmLimiter.acquire();
              return d.generator.generate(profile);
            }),
          { ...d.retry, onRetry: (i) => log.warn({ event: 'llm_retry', attempt: i.attempt, delayMs: i.delayMs, err: i.error.message }, 'LLM falhou, nova tentativa') },
        );
        const costUsd = estimateCostUsd(value.usage, d.pricing);
        d.budget.commit(costUsd);
        await d.cache.set(key, value.summary);
        return { summary: value.summary, source: 'llm', usage: value.usage, costUsd, attempts };
      } finally {
        release();
      }
    } catch (error) {
      const info = toErrorInfo(error);
      if (!d.fallbackOnLlmFailure || info.kind === 'unexpected') throw error;
      // Degradação elegante: o aluno recebe o boletim com texto determinístico; o relatório registra o motivo.
      log.warn({ event: 'llm_fallback', kind: info.kind, err: info.message }, 'usando resumo determinístico');
      return {
        summary: buildFallbackSummary(profile),
        source: 'fallback',
        usage: NO_USAGE,
        costUsd: 0,
        attempts: error instanceof RetryExhaustedError ? error.attempts : 1,
        degradedBy: info,
      };
    }
  }

  private async send(
    ctx: RunContext,
    student: StudentGrades,
    profile: GradeProfile,
    summary: SummaryText,
    version: string,
    updated: boolean,
    changes: GradeChange[],
    log: AppLogger,
  ): Promise<void> {
    const d = this.deps;
    const message = renderBulletin({ runId: ctx.runId, period: ctx.period, student, profile, summary, version, updated, changes });
    await this.deliver(message, log);
  }

  private async deliver(message: NotificationMessage, log: AppLogger): Promise<void> {
    const d = this.deps;
    await withRetry(
      () =>
        d.notifyBreaker.exec(async () => {
          await d.notifyLimiter.acquire();
          await d.notifier.send(message);
        }),
      { ...d.retry, onRetry: (i) => log.warn({ event: 'notify_retry', attempt: i.attempt, delayMs: i.delayMs, err: i.error.message }, 'envio falhou, nova tentativa') },
    );
  }
}
