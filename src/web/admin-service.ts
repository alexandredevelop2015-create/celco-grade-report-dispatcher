import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AppConfig } from '../config/config';
import { Notifier, SummaryGenerator, TOKENS } from '../domain/ports';
import { StudentRecord } from '../domain/types';
import { CsvGradeSource } from '../grades/csv-grade-source';
import { CsvGradeRepository, StudentView } from '../grades/grade-repository';
import { diffGrades, studentDataHash } from '../grades/profile';
import { AuditEvent, renderAudit } from '../notify/render-audit';
import { AppLogger, createLogger } from '../observability/logger';
import { DispatcherService } from '../pipeline/dispatcher.service';
import { RunReport } from '../pipeline/report';
import { withRetry } from '../resilience/retry';
import { JsonStateStore } from '../store/json-state-store';

export interface AdminOptions {
  config: AppConfig;
  csvPath: string;
  period: string;
  /** Substitui o canal de e-mail configurado (testes). */
  notifier?: Notifier;
}

export interface MutationResult {
  student?: StudentView;
  /** O que aconteceu com o e-mail do aluno. */
  studentNotice: string;
  audit: { status: 'sent' | 'skipped' | 'failed'; message: string };
  report?: Pick<RunReport['result'], 'sent' | 'failed'> & { costUsd: number };
}

type PipelineRun = { report?: RunReport; notifier: Notifier };

/**
 * Casos de uso da interface: altera o CSV, roda o pipeline de envio (que avisa o aluno por e-mail) e manda a
 * auditoria à secretaria. Todas as operações passam por uma fila única: o CSV e o state.json têm um escritor por vez.
 */
export class AdminService {
  readonly repo: CsvGradeRepository;
  private readonly statePath: string;
  private readonly logger: AppLogger;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AdminOptions) {
    this.repo = new CsvGradeRepository(options.csvPath, options.config.GRADE_SCALE_MAX);
    this.statePath = join(options.config.OUTPUT_DIR, options.period, 'state.json');
    this.logger = createLogger(options.config.LOG_LEVEL);
  }

  get period(): string {
    return this.options.period;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  create(input: unknown, notify: boolean): Promise<MutationResult> {
    return this.exclusive(async () => {
      const started = new Date();
      const student = await this.repo.create(input);
      const run = await this.pipeline(notify);
      const notice = await this.noticeFor(student.studentId, started, notify, run, 'criado');
      return this.finish(run, notice, student, {
        action: 'criado',
        studentId: student.studentId,
        studentName: student.name,
        changes: [`e-mail: ${student.email}`, ...student.grades.map((g) => `${g.subject}: ${g.grade}`)],
      });
    });
  }

  update(studentId: string, input: unknown, notify: boolean): Promise<MutationResult> {
    return this.exclusive(async () => {
      const started = new Date();
      const { before, after } = await this.repo.replace(studentId, input);
      const run = await this.pipeline(notify);
      const notice = await this.noticeFor(studentId, started, notify, run, 'alterado');
      const changes: string[] = [];
      if (before.name !== after.name) changes.push(`nome: ${before.name} → ${after.name}`);
      if (before.email !== after.email) changes.push(`e-mail: ${before.email} → ${after.email}`);
      if ((before.phone ?? '') !== (after.phone ?? '')) changes.push(`WhatsApp: ${before.phone ?? 'sem número'} → ${after.phone ?? 'sem número'}`);
      for (const c of diffGrades(before.grades, after.grades)) {
        changes.push(
          c.after === undefined
            ? `${c.subject}: removida (era ${c.before})`
            : c.before === undefined
              ? `${c.subject}: ${c.after} (nova)`
              : `${c.subject}: ${c.before} → ${c.after}`,
        );
      }
      return this.finish(run, notice, after, {
        action: 'alterado',
        studentId,
        studentName: after.name,
        changes: changes.length ? changes : ['nenhuma diferença nas notas ou nos dados'],
      });
    });
  }

  remove(studentId: string, notify: boolean): Promise<MutationResult> {
    return this.exclusive(async () => {
      const started = new Date();
      const before = await this.repo.remove(studentId);
      const run = await this.pipeline(notify, [], await this.onlyThisRemoved(studentId));
      const notice = await this.noticeFor(studentId, started, notify, run, 'removido');
      return this.finish(run, notice, undefined, {
        action: 'removido',
        studentId,
        studentName: before.name,
        changes: [`e-mail: ${before.email}`, ...before.grades.map((g) => `${g.subject}: ${g.grade} (anulada)`)],
      });
    });
  }

  /** Execução manual do período inteiro; `resend` força o reenvio de alunos sem mudança. */
  dispatch(resend: string[] = []): Promise<MutationResult> {
    return this.exclusive(async () => {
      const run = await this.pipeline(true, resend);
      const r = run.report?.result;
      return this.finish(
        run,
        r ? `${r.sent} e-mail(s) enviados, ${r.failed} falha(s), ${r.skippedAlreadySent} já enviados antes` : 'sem resultado',
        undefined,
        {
          action: 'execucao',
          changes: r
            ? [`enviados: ${r.sent} (${r.updatedResent} atualizados, ${r.removed} removidos)`, `falhas: ${r.failed}`, `ignorados (já enviados): ${r.skippedAlreadySent}`, `custo estimado: US$ ${run.report!.costUsd.toFixed(6)}`]
            : [],
          resend,
        },
      );
    });
  }

  /** Foto completa para a tela: alunos + estado de envio, relatório, planilha de alterações e eventos. */
  async snapshot() {
    const { config, csvPath, period } = this.options;
    const students = await this.repo.list();
    let load: Awaited<ReturnType<CsvGradeSource['load']>> | undefined;
    let loadError: string | undefined;
    try {
      load = await new CsvGradeSource(csvPath, { scaleMax: config.GRADE_SCALE_MAX }).load();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
    const store = await JsonStateStore.open(this.statePath);
    const records = new Map((await store.list(period)).map((r) => [r.studentId, r]));
    const valid = new Map((load?.students ?? []).map((s) => [s.studentId, s]));
    const quarantined = new Set(load?.quarantined ?? []);

    const rows = students.map((s) => {
      const record = records.get(s.studentId);
      const current = valid.get(s.studentId);
      let status: string;
      if (quarantined.has(s.studentId) || s.conflict) status = 'QUARENTENA';
      else if (!current) status = 'INVALIDO';
      else if (!record || record.status === 'REMOVED') status = 'PENDENTE';
      else if (record.status === 'FAILED') status = 'FALHA';
      else if (record.dataHash && record.dataHash !== studentDataHash(current)) status = 'DESATUALIZADO';
      else status = record.status === 'SENT' ? 'ENVIADO' : 'PENDENTE';
      const average = s.grades.length ? Math.round((s.grades.reduce((a, g) => a + g.grade, 0) / s.grades.length) * 100) / 100 : 0;
      return { ...s, average, status, error: record?.error?.message, updatedAt: record?.updatedAt, summarySource: record?.summarySource };
    });

    return {
      period,
      file: csvPath,
      scaleMax: config.GRADE_SCALE_MAX,
      passMark: config.PASS_MARK,
      notifier: config.NOTIFIER,
      llm: config.LLM_PROVIDER,
      auditEmail: Boolean(config.ADMIN_EMAIL),
      loadError,
      students: rows,
      rejected: load?.rejected ?? [],
      report: await readJson<RunReport>(join(config.OUTPUT_DIR, period, 'report.json')),
      changes: await this.readChanges(),
      events: await this.readEvents(),
    };
  }

  private async pipeline(notify: boolean, resend: string[] = [], confirmRemovals = false): Promise<PipelineRun> {
    const { config, csvPath, period } = this.options;
    const app = await NestFactory.createApplicationContext(AppModule.register({ config, csvPath, statePath: this.statePath, notifier: this.options.notifier }), {
      logger: ['error', 'warn'],
    });
    try {
      const notifier = app.get<Notifier>(TOKENS.NOTIFIER);
      if (!notify) return { notifier };
      const generator = app.get<SummaryGenerator>(TOKENS.SUMMARY_GENERATOR);
      const report = await app.get(DispatcherService).run({
        runId: period,
        period,
        concurrency: config.CONCURRENCY,
        resend,
        confirmRemovals,
        outputDir: config.OUTPUT_DIR,
        model: generator.model,
      });
      return { report, notifier };
    } finally {
      // O notifier não guarda conexão: pode ser usado para a auditoria depois do contexto fechado.
      await app.close();
    }
  }

  /**
   * A exclusão foi confirmada na tela, então a trava contra "arquivo errado" do dispatcher só atrapalharia (ex.: excluir
   * o último aluno deixa o CSV vazio). Mas só se ESTE for o único aluno entregue que sumiu do CSV: se houver outros
   * (edição manual do arquivo), a trava continua valendo.
   */
  private async onlyThisRemoved(studentId: string): Promise<boolean> {
    const remaining = new Set((await this.repo.list()).map((s) => s.studentId));
    const records = await (await JsonStateStore.open(this.statePath)).list(this.period);
    const gone = records.filter((r) => (r.status === 'SENT' || r.lastSentGrades !== undefined) && !remaining.has(r.studentId));
    return gone.every((r) => r.studentId === studentId);
  }

  /** Descreve, em uma frase, o que aconteceu com o e-mail do aluno nesta operação. */
  private async noticeFor(studentId: string, since: Date, notify: boolean, run: PipelineRun, action: 'criado' | 'alterado' | 'removido'): Promise<string> {
    if (!notify) return 'não enviado (opção "avisar o aluno" desmarcada); sai na próxima execução';
    const record: StudentRecord | undefined = (await (await JsonStateStore.open(this.statePath)).list(this.period)).find((r) => r.studentId === studentId);
    const fresh = record !== undefined && new Date(record.updatedAt) >= since;
    if (action === 'removido') {
      if (record?.status === 'REMOVED' && fresh) return `aviso de remoção enviado para ${record.email}`;
      if (!record || !record.lastSentGrades) return 'o aluno nunca recebeu boletim neste período: nenhum aviso necessário';
      return 'aviso de remoção NÃO enviado (veja o relatório)';
    }
    if (!record) return 'sem envio: o lançamento está inválido ou em quarentena (veja as linhas rejeitadas)';
    if (record.status === 'FAILED') return `FALHA no envio: ${record.error?.message ?? 'erro desconhecido'}`;
    if (record.status === 'SENT' && fresh) return `${action === 'criado' ? 'boletim' : 'boletim atualizado'} enviado para ${record.email}`;
    return 'sem alteração nas notas: nenhum e-mail enviado ao aluno';
  }

  private async finish(
    run: PipelineRun,
    studentNotice: string,
    student: StudentView | undefined,
    event: Omit<AuditEvent, 'id' | 'period' | 'at' | 'studentNotice'> & { resend?: string[] },
  ): Promise<MutationResult> {
    const audit = await this.audit(run.notifier, { ...event, id: randomUUID(), period: this.period, at: new Date(), studentNotice });
    const r = run.report;
    return {
      student,
      studentNotice,
      audit,
      report: r ? { sent: r.result.sent, failed: r.result.failed, costUsd: r.costUsd } : undefined,
    };
  }

  private async audit(notifier: Notifier, event: AuditEvent): Promise<MutationResult['audit']> {
    const to = this.options.config.ADMIN_EMAIL;
    if (!to) return { status: 'skipped', message: 'ADMIN_EMAIL não configurado: auditoria por e-mail desligada' };
    const { config } = this.options;
    try {
      await withRetry(() => notifier.send(renderAudit(to, event)), {
        attempts: config.RETRY_ATTEMPTS,
        baseDelayMs: config.RETRY_BASE_MS,
        maxDelayMs: config.RETRY_MAX_MS,
      });
      return { status: 'sent', message: `auditoria enviada para ${to}` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ event: 'audit_failed', err: message }, 'falha ao enviar o e-mail de auditoria');
      return { status: 'failed', message };
    }
  }

  private async readChanges(): Promise<Record<string, string>[]> {
    const content = await readFile(join(this.options.config.OUTPUT_DIR, this.period, 'alteracoes.csv'), 'utf8').catch(() => undefined);
    if (!content) return [];
    const rows = parse(content, { delimiter: ';', columns: true, bom: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
    return rows.slice(-200).reverse();
  }

  private async readEvents(): Promise<unknown[]> {
    const content = await readFile(join(this.options.config.OUTPUT_DIR, 'events.ndjson'), 'utf8').catch(() => '');
    const events: unknown[] = [];
    for (const line of content.split('\n').slice(-400)) {
      try {
        const e = JSON.parse(line) as { runId?: string };
        if (e.runId === this.period) events.push(e);
      } catch {
        // linha parcial/vazia
      }
    }
    return events.slice(-60).reverse();
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
