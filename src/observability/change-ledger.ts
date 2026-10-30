import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StudentOutcome } from '../pipeline/student-processor';

const HEADER = ['data_hora', 'aluno_id', 'aluno', 'tipo', 'disciplina', 'nota_anterior', 'nota_nova', 'resultado'];

const cell = (v: string | number | undefined): string => {
  // Excel em português espera vírgula decimal.
  const s = v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  // Neutraliza fórmulas (=, +, -, @) abertas pelo Excel a partir de texto vindo do CSV.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/**
 * Planilha de auditoria (alteracoes.csv): cada lançamento de aluno novo, nota alterada ou reenvio vira linhas
 * com antes/depois e o resultado do envio. Separador ';' e BOM para abrir direto no Excel em português.
 * Só cresce (append): é o histórico, o state.json guarda apenas o valor atual.
 */
export class ChangeLedger {
  constructor(private readonly path: string) {}

  async append(outcomes: StudentOutcome[], when: Date = new Date()): Promise<number> {
    const rows: string[] = [];
    const stamp = when.toISOString().replace('T', ' ').slice(0, 19);
    for (const o of outcomes) {
      if (o.status === 'skipped' || !o.kind) continue;
      const resultado = o.status === 'sent' ? 'enviado' : `falha: ${o.error?.kind ?? 'desconhecida'}`;
      const base = [stamp, o.studentId, o.studentName, o.kind];
      const lines = o.changes?.length ? o.changes : [{ subject: undefined, before: undefined, after: undefined }];
      for (const c of lines) {
        rows.push([...base, c.subject, c.before, c.after, resultado].map(cell).join(';'));
      }
    }
    if (!rows.length) return 0;

    await mkdir(dirname(this.path), { recursive: true });
    const exists = await readFile(this.path, 'utf8').then(() => true, () => false);
    const head = exists ? '' : '\uFEFF' + HEADER.join(';') + '\r\n';
    await appendFile(this.path, head + rows.join('\r\n') + '\r\n', 'utf8');
    return rows.length;
  }
}
