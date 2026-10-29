import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GradeSource } from '../src/domain/ports';
import { LoadResult } from '../src/domain/types';
import { InMemoryAnalyticsSink } from '../src/observability/analytics';
import { createLogger } from '../src/observability/logger';
import { DispatcherService } from '../src/pipeline/dispatcher.service';
import { percentile } from '../src/pipeline/report';
import { buildProcessor, student } from './helpers';

const load = (n: number): LoadResult => ({
  students: Array.from({ length: n }, (_, i) => student(`A${i}`, [['Algoritmos', 10 + (i % 3)]])),
  rejected: [{ line: 99, reason: 'INVALID_EMAIL', field: 'email' }],
  duplicatesIgnored: 2,
  quarantined: [],
  seenIds: Array.from({ length: n }, (_, i) => `A${i}`),
  totalRows: n + 3,
});

describe('DispatcherService (integração do pipeline)', () => {
  it('processa o lote, gera relatório com métricas e eventos de analytics', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'dispatch-'));
    const { processor, notifier } = buildProcessor();
    const analytics = new InMemoryAnalyticsSink();
    const source: GradeSource = { load: async () => load(9) };
    const service = new DispatcherService(source, processor, analytics, createLogger('silent'));

    const report = await service.run({ runId: 'r1', period: '2026-1S', concurrency: 3, outputDir, model: 'fake-model' });

    expect(report.result.sent).toBe(9);
    expect(report.result.failed).toBe(0);
    // 3 perfis distintos: 3 chamadas ao LLM, o resto vem do cache
    expect(report.result.llmGenerated + report.result.cacheHits).toBe(9);
    expect(report.result.cacheHits).toBeGreaterThanOrEqual(6);
    expect(report.input).toMatchObject({ rejectedRows: 1, duplicatesIgnored: 2, students: 9 });
    expect(report.tokens.total).toBeGreaterThan(0);
    expect(report.costUsd).toBeGreaterThan(0);
    expect(notifier.sent).toHaveLength(9);

    const names = analytics.events.map((e) => e.name);
    expect(names[0]).toBe('run_started');
    expect(names.filter((n) => n === 'student_processed')).toHaveLength(9);
    expect(names.at(-1)).toBe('run_completed');

    const saved = JSON.parse(await readFile(join(outputDir, 'r1', 'report.json'), 'utf8')) as { runId: string };
    expect(saved.runId).toBe('r1');
  });

  it('rodar duas vezes o mesmo período não duplica envios', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'dispatch-'));
    const { processor, notifier } = buildProcessor();
    const source: GradeSource = { load: async () => load(4) };
    const service = new DispatcherService(source, processor, new InMemoryAnalyticsSink(), createLogger('silent'));
    const opts = { runId: 'r1', period: '2026-1S', concurrency: 2, outputDir, model: 'm' };

    await service.run(opts);
    const second = await service.run(opts);

    expect(notifier.sent).toHaveLength(4);
    expect(second.result).toMatchObject({ sent: 0, skippedAlreadySent: 4 });
  });

  it('validateOnly não chama LLM nem envia', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'dispatch-'));
    const { processor, notifier } = buildProcessor();
    const service = new DispatcherService({ load: async () => load(3) }, processor, new InMemoryAnalyticsSink(), createLogger('silent'));
    const report = await service.run({ runId: 'v', period: 'p', concurrency: 1, validateOnly: true, outputDir, model: 'm' });
    expect(notifier.sent).toHaveLength(0);
    expect(report.result.sent).toBe(0);
    expect(report.input.students).toBe(3);
  });
});

describe('percentile', () => {
  it('calcula p50 e p95 sobre lista ordenada', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('lançamento removido do CSV', () => {
  const setup = async (n: number) => {
    const outputDir = await mkdtemp(join(tmpdir(), 'dispatch-'));
    const built = buildProcessor();
    const current = { value: load(n) };
    const service = new DispatcherService({ load: async () => current.value }, built.processor, new InMemoryAnalyticsSink(), createLogger('silent'));
    const opts = { runId: 'r1', period: '2026-1S', concurrency: 2, outputDir, model: 'm' };
    return { service, opts, current, ...built };
  };

  it('avisa o aluno que sumiu do CSV, uma única vez, e o registro vira REMOVED', async () => {
    const { service, opts, current, notifier, store } = await setup(5);
    await service.run(opts);
    notifier.sent = [];

    const base = current.value;
    current.value = { ...base, students: base.students.filter((s) => s.studentId !== 'A2'), seenIds: base.seenIds.filter((id) => id !== 'A2') };
    const report = await service.run(opts);

    expect(report.result.removed).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.subject).toContain('(lançamento removido)');
    expect(notifier.sent[0]!.text).toContain('Notas anuladas');
    expect((await store.get('r1', 'A2'))?.status).toBe('REMOVED');

    const again = await service.run(opts);
    expect(again.result.removed).toBe(0);
    expect(notifier.sent).toHaveLength(1);
  });

  it('aluno com linha rejeitada (mas ainda no CSV) NÃO é tratado como removido', async () => {
    const { service, opts, current, notifier } = await setup(5);
    await service.run(opts);
    notifier.sent = [];
    const base = current.value;
    // A2 continua no arquivo (seenIds), só que a linha dele foi rejeitada e ele não está em `students`
    current.value = { ...base, students: base.students.filter((s) => s.studentId !== 'A2') };
    const report = await service.run(opts);
    expect(report.result.removed).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it('trava de segurança: sumiço em massa não envia nada sem --confirm-removals', async () => {
    const { service, opts, current, notifier } = await setup(8);
    await service.run(opts);
    notifier.sent = [];
    const base = current.value;
    current.value = { ...base, students: base.students.slice(0, 2), seenIds: ['A0', 'A1'] };

    const blocked = await service.run(opts);
    expect(blocked.result.removalsBlocked).toBe(6);
    expect(blocked.result.removed).toBe(0);
    expect(notifier.sent).toHaveLength(0);

    const confirmed = await service.run({ ...opts, confirmRemovals: true });
    expect(confirmed.result.removed).toBe(6);
    expect(notifier.sent).toHaveLength(6);
  });

  it('CSV vazio (sem nenhum aluno) também é bloqueado', async () => {
    const { service, opts, current, notifier } = await setup(4);
    await service.run(opts);
    notifier.sent = [];
    current.value = { ...current.value, students: [], seenIds: [] };
    const report = await service.run(opts);
    expect(report.result.removalsBlocked).toBe(4);
    expect(notifier.sent).toHaveLength(0);
  });

  it('aluno removido que volta ao CSV recebe boletim como novo', async () => {
    const { service, opts, current, notifier } = await setup(5);
    await service.run(opts);
    const base = current.value;
    current.value = { ...base, students: base.students.filter((s) => s.studentId !== 'A2'), seenIds: base.seenIds.filter((id) => id !== 'A2') };
    await service.run(opts);
    notifier.sent = [];
    current.value = base;
    const report = await service.run(opts);
    expect(report.result.sent).toBe(1);
    expect(notifier.sent[0]!.subject).toBe('Boletim 2026-1S');
  });
});
