import { ErrorKind, LoadResult, RejectedRow } from '../domain/types';
import { StudentOutcome } from './student-processor';

export interface RunReport {
  runId: string;
  traceId: string;
  period: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  input: {
    totalRows: number;
    students: number;
    rejectedRows: number;
    duplicatesIgnored: number;
    quarantinedStudents: number;
  };
  result: {
    sent: number;
    failed: number;
    skippedAlreadySent: number;
    failureRate: number;
    llmGenerated: number;
    cacheHits: number;
    fallbackUsed: number;
  };
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  latencyMs: { avgPerStudent: number; p50: number; p95: number };
  throughputPerSec: number;
  failures: { studentId: string; kind: ErrorKind; message: string }[];
  degraded: { reason: ErrorKind; count: number }[];
  rejected: RejectedRow[];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function buildReport(params: {
  runId: string;
  traceId: string;
  period: string;
  model: string;
  startedAt: Date;
  finishedAt: Date;
  load: LoadResult;
  outcomes: StudentOutcome[];
}): RunReport {
  const { load, outcomes } = params;
  const processed = outcomes.filter((o) => o.status !== 'skipped');
  const sent = outcomes.filter((o) => o.status === 'sent');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const durationMs = params.finishedAt.getTime() - params.startedAt.getTime();
  const times = processed.map((o) => o.durationMs).sort((a, b) => a - b);
  const inputTokens = outcomes.reduce((s, o) => s + o.usage.inputTokens, 0);
  const outputTokens = outcomes.reduce((s, o) => s + o.usage.outputTokens, 0);

  const degradedCounts = new Map<ErrorKind, number>();
  for (const o of sent) {
    if (o.source === 'fallback' && o.error) degradedCounts.set(o.error.kind, (degradedCounts.get(o.error.kind) ?? 0) + 1);
  }

  return {
    runId: params.runId,
    traceId: params.traceId,
    period: params.period,
    model: params.model,
    startedAt: params.startedAt.toISOString(),
    finishedAt: params.finishedAt.toISOString(),
    durationMs,
    input: {
      totalRows: load.totalRows,
      students: load.students.length,
      rejectedRows: load.rejected.length,
      duplicatesIgnored: load.duplicatesIgnored,
      quarantinedStudents: load.quarantined.length,
    },
    result: {
      sent: sent.length,
      failed: failed.length,
      skippedAlreadySent: outcomes.length - processed.length,
      failureRate: processed.length ? round(failed.length / processed.length, 4) : 0,
      llmGenerated: outcomes.filter((o) => o.source === 'llm').length,
      cacheHits: outcomes.filter((o) => o.source === 'cache').length,
      fallbackUsed: outcomes.filter((o) => o.source === 'fallback').length,
    },
    tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    costUsd: round(
      outcomes.reduce((s, o) => s + o.costUsd, 0),
      6,
    ),
    latencyMs: {
      avgPerStudent: times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : 0,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
    },
    throughputPerSec: durationMs > 0 ? round((processed.length / durationMs) * 1000, 2) : 0,
    failures: failed.map((o) => ({
      studentId: o.studentId,
      kind: o.error?.kind ?? 'unexpected',
      message: o.error?.message ?? 'sem detalhe',
    })),
    degraded: [...degradedCounts].map(([reason, count]) => ({ reason, count })),
    rejected: load.rejected,
  };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function renderReportMarkdown(r: RunReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `# Relatório de execução: ${r.period}`,
    '',
    `- Execução: \`${r.runId}\` · trace \`${r.traceId}\` · modelo \`${r.model}\``,
    `- Duração: ${r.durationMs} ms · vazão: ${r.throughputPerSec} alunos/s`,
    '',
    '## Entrada',
    `- Linhas lidas: ${r.input.totalRows} · alunos válidos: ${r.input.students}`,
    `- Linhas rejeitadas: ${r.input.rejectedRows} · duplicadas ignoradas: ${r.input.duplicatesIgnored} · alunos em quarentena: ${r.input.quarantinedStudents}`,
    '',
    '## Resultado',
    `- Enviados: ${r.result.sent} · falhas: ${r.result.failed} (${pct(r.result.failureRate)}) · já enviados antes: ${r.result.skippedAlreadySent}`,
    `- Resumo por LLM: ${r.result.llmGenerated} · cache: ${r.result.cacheHits} · fallback determinístico: ${r.result.fallbackUsed}`,
    '',
    '## Custo e latência',
    `- Tokens: ${r.tokens.input} entrada + ${r.tokens.output} saída = ${r.tokens.total}`,
    `- Custo estimado: US$ ${r.costUsd.toFixed(6)}`,
    `- Tempo por aluno: média ${r.latencyMs.avgPerStudent} ms · p50 ${r.latencyMs.p50} ms · p95 ${r.latencyMs.p95} ms`,
  ];
  if (r.degraded.length) {
    lines.push('', '## Degradação (fallback usado)', ...r.degraded.map((d) => `- ${d.reason}: ${d.count}`));
  }
  if (r.failures.length) {
    lines.push('', '## Falhas', ...r.failures.map((f) => `- ${f.studentId} [${f.kind}] ${f.message}`));
  }
  if (r.rejected.length) {
    lines.push('', '## Linhas rejeitadas', ...r.rejected.map((x) => `- linha ${x.line}: ${x.reason}${x.field ? ` (${x.field})` : ''}`));
  }
  return lines.join('\n') + '\n';
}
