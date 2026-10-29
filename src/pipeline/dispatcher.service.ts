import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AnalyticsSink, GradeSource } from '../domain/ports';
import { LoadResult } from '../domain/types';
import { AppLogger } from '../observability/logger';
import { ChangeLedger } from '../observability/change-ledger';
import { Tracer } from '../observability/tracer';
import { runWithConcurrency } from '../resilience/concurrency';
import { buildReport, renderReportMarkdown, RunReport } from './report';
import { StudentOutcome, StudentProcessor } from './student-processor';

export interface DispatchOptions {
  /** Identifica a execução e é a base da idempotência. Mesmo `runId` = retoma de onde parou. */
  runId: string;
  period: string;
  concurrency: number;
  /** Só lê e valida o arquivo: não chama LLM nem envia nada. */
  validateOnly?: boolean;
  /** Alunos a reenviar mesmo sem mudança nas notas (ex.: pedido da secretaria). */
  resend?: string[];
  /** Libera o envio de avisos de remoção mesmo quando a trava de segurança dispara. */
  confirmRemovals?: boolean;
  outputDir: string;
  model: string;
}

/** Orquestra: ler/validar -> processar alunos em paralelo -> relatório. Não conhece LLM nem SMTP. */
export class DispatcherService {
  constructor(
    private readonly source: GradeSource,
    private readonly processor: StudentProcessor,
    private readonly analytics: AnalyticsSink,
    private readonly logger: AppLogger,
  ) {}

  async run(options: DispatchOptions): Promise<RunReport> {
    const startedAt = new Date();
    const tracer = new Tracer(this.logger);
    const log = this.logger.child({ runId: options.runId, traceId: tracer.traceId });

    const load = await tracer.span('load_grades', {}, () => this.source.load());
    log.info(
      {
        event: 'grades_loaded',
        rows: load.totalRows,
        students: load.students.length,
        rejected: load.rejected.length,
        duplicatesIgnored: load.duplicatesIgnored,
        quarantined: load.quarantined.length,
      },
      'notas carregadas',
    );
    this.analytics.track({ name: 'run_started', runId: options.runId, period: options.period, students: load.students.length });

    let outcomes: StudentOutcome[] = [];
    let removalsBlocked = 0;
    if (!options.validateOnly) {
      const ctx = { runId: options.runId, period: options.period, traceId: tracer.traceId };
      const resend = new Set(options.resend ?? []);
      for (const id of resend) {
        if (!load.students.some((s) => s.studentId === id)) {
          log.warn({ event: 'resend_not_found', studentId: id }, '--resend: aluno não está no CSV (ou está em quarentena)');
        }
      }
      outcomes = await tracer.span('process_students', { students: load.students.length }, () =>
        runWithConcurrency(load.students, options.concurrency, async (student) => {
          const outcome = await this.processor.process(ctx, student, { forceResend: resend.has(student.studentId) });
          this.trackStudent(options.runId, outcome);
          return outcome;
        }),
      );

      // Lançamento apagado do CSV => avisa o aluno. Trava: apagar quase tudo costuma ser arquivo errado.
      const present = new Set(load.seenIds);
      const { candidates, deliveredTotal } = await this.processor.findRemovals(options.runId, present);
      const suspicious = present.size === 0 || candidates.length > Math.max(3, Math.floor(deliveredTotal / 2));
      if (candidates.length && suspicious && !options.confirmRemovals) {
        removalsBlocked = candidates.length;
        log.warn(
          { event: 'removals_blocked', removals: candidates.length, deliveredTotal },
          'muitas remoções de uma vez (ou CSV vazio): nada foi enviado. Confira o arquivo e use --confirm-removals se for isso mesmo',
        );
      } else if (candidates.length) {
        const removals = await runWithConcurrency(candidates, options.concurrency, async (record) => {
          const outcome = await this.processor.processRemoval(ctx, record);
          if (outcome) this.trackStudent(options.runId, outcome);
          return outcome;
        });
        outcomes = [...outcomes, ...removals.filter((o): o is StudentOutcome => o !== undefined)];
      }
    }

    const changeRows = await new ChangeLedger(join(options.outputDir, options.runId, 'alteracoes.csv')).append(outcomes);
    if (changeRows) log.info({ event: 'changes_recorded', rows: changeRows }, 'alterações registradas em alteracoes.csv');

    const report = buildReport({
      runId: options.runId,
      traceId: tracer.traceId,
      period: options.period,
      model: options.model,
      startedAt,
      finishedAt: new Date(),
      load: load satisfies LoadResult,
      outcomes,
      removalsBlocked,
    });

    await this.writeReport(options.outputDir, report);
    this.analytics.track({
      name: 'run_completed',
      runId: options.runId,
      durationMs: report.durationMs,
      sent: report.result.sent,
      failed: report.result.failed,
      failureRate: report.result.failureRate,
      costUsd: report.costUsd,
    });
    log.info({ event: 'run_completed', ...report.result, costUsd: report.costUsd, durationMs: report.durationMs }, 'execução concluída');
    return report;
  }

  private trackStudent(runId: string, o: StudentOutcome): void {
    this.analytics.track({
      name: 'student_processed',
      runId,
      studentId: o.studentId,
      outcome: o.status,
      source: o.source,
      durationMs: o.durationMs,
      costUsd: o.costUsd,
    });
    if (o.status === 'failed' && o.error) {
      this.analytics.track({ name: 'student_failed', runId, studentId: o.studentId, kind: o.error.kind });
    }
  }

  private async writeReport(outputDir: string, report: RunReport): Promise<void> {
    const dir = join(outputDir, report.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(dir, 'report.md'), renderReportMarkdown(report));
  }
}
