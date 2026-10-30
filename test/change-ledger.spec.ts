import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffGrades } from '../src/grades/profile';
import { ChangeLedger } from '../src/observability/change-ledger';
import { StudentOutcome } from '../src/pipeline/student-processor';

const outcome = (over: Partial<StudentOutcome>): StudentOutcome => ({
  studentId: 'A1',
  studentName: 'Ana Ribeiro',
  status: 'sent',
  kind: 'atualizado',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  llmAttempts: 0,
  durationMs: 1,
  ...over,
});

describe('diffGrades', () => {
  it('detecta alterada, nova e removida', () => {
    const d = diffGrades(
      [{ subject: 'A', grade: 10 }, { subject: 'B', grade: 12 }, { subject: 'C', grade: 9 }],
      [{ subject: 'A', grade: 10 }, { subject: 'B', grade: 15 }, { subject: 'D', grade: 18 }],
    );
    expect(d).toEqual([
      { subject: 'B', before: 12, after: 15 },
      { subject: 'C', before: 9 },
      { subject: 'D', after: 18 },
    ]);
  });
});

describe('ChangeLedger', () => {
  it('cria a planilha com cabeçalho, BOM e ponto e vírgula, e acumula nas execuções seguintes', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ledger-')), 'alteracoes.csv');
    const ledger = new ChangeLedger(path);
    const when = new Date('2026-10-29T15:00:00Z');

    await ledger.append([outcome({ changes: [{ subject: 'Matemática', before: 7, after: 15 }] })], when);
    await ledger.append([outcome({ studentId: 'A2', studentName: 'Bia', kind: 'novo', changes: [{ subject: 'Algoritmos', after: 14 }] })], when);

    const text = await readFile(path, 'utf8');
    expect(text.startsWith('﻿data_hora;aluno_id;')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"2026-10-29 15:00:00";"A1";"Ana Ribeiro";"atualizado";"Matemática";"7";"15";"enviado"');
    expect(lines[2]).toContain('"novo";"Algoritmos";"";"14"');
  });

  it('registra falhas, ignora "skipped" e neutraliza fórmulas do Excel', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ledger-')), 'alteracoes.csv');
    const ledger = new ChangeLedger(path);
    const n = await ledger.append([
      outcome({ status: 'skipped', kind: undefined }),
      outcome({ studentName: '=HYPERLINK("x")', status: 'failed', error: { kind: 'fatal', message: 'x' }, changes: [] }),
    ]);
    expect(n).toBe(1);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('"\'=HYPERLINK(""x"")"');
    expect(text).toContain('"falha: fatal"');
  });

  it('não cria arquivo quando não há nada a registrar', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ledger-')), 'alteracoes.csv');
    expect(await new ChangeLedger(path).append([outcome({ status: 'skipped', kind: undefined })])).toBe(0);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});

describe('ChangeLedger: decimais', () => {
  it('grava decimais com vírgula para o Excel em português', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ledger-')), 'alteracoes.csv');
    await new ChangeLedger(path).append([outcome({ changes: [{ subject: 'Algoritmos', before: 12.5, after: 13.5 }] })]);
    expect(await readFile(path, 'utf8')).toContain('"12,5";"13,5"');
  });
});
