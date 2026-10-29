import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { FatalError } from '../domain/errors';
import { GradeSource } from '../domain/ports';
import { LoadResult, RejectedRow, RejectReason, StudentGrades } from '../domain/types';
import { sanitizeText } from './sanitize';

const REQUIRED_HEADERS = ['student_id', 'name', 'email', 'subject', 'grade'];

export interface CsvOptions {
  scaleMax: number;
}

interface CsvRecord {
  record: Record<string, string | undefined>;
  info: { lines: number };
}

const rowSchema = (scaleMax: number) =>
  z.object({
    student_id: z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().min(1).max(100),
    email: z.string().email().max(120),
    subject: z.string().min(1).max(80),
    grade: z.number().min(0).max(scaleMax),
  });

function reasonFor(field: string, value: string | undefined): RejectReason {
  if (value === undefined || value.trim() === '') return 'MISSING_FIELD';
  if (field === 'email') return 'INVALID_EMAIL';
  if (field === 'grade') return 'INVALID_GRADE';
  return 'INVALID_FIELD';
}

/** Cabeçalho com ';' e sem ',' => separador é ponto e vírgula. */
export function detectDelimiter(content: string): ',' | ';' {
  const header = content.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return header.includes(';') && !header.includes(',') ? ';' : ',';
}

/** Aceita "17,5" e "17.5"; qualquer outra coisa vira NaN e é rejeitada pelo schema. */
function parseGrade(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return NaN;
  return Number(raw.trim().replace(',', '.'));
}

export class CsvGradeSource implements GradeSource {
  constructor(
    private readonly path: string,
    private readonly options: CsvOptions,
  ) {}

  async load(): Promise<LoadResult> {
    const content = await readFile(this.path, 'utf8').catch((e: unknown) => {
      throw new FatalError(`Não foi possível ler o ficheiro de notas: ${(e as Error).message}`);
    });
    return parseGradesCsv(content, this.options);
  }
}

export function parseGradesCsv(content: string, options: CsvOptions): LoadResult {
  let records: CsvRecord[];
  try {
    records = parse(content, {
      // Excel em português salva com ';': detecta pelo cabeçalho.
      delimiter: detectDelimiter(content),
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      info: true,
    }) as CsvRecord[];
  } catch (e) {
    throw new FatalError(`CSV ilegível: ${(e as Error).message}`);
  }

  if (records.length > 0) {
    const present = Object.keys(records[0]!.record);
    const missing = REQUIRED_HEADERS.filter((h) => !present.includes(h));
    if (missing.length) throw new FatalError(`Cabeçalhos em falta no CSV: ${missing.join(', ')}`);
  }

  const schema = rowSchema(options.scaleMax);
  const rejected: RejectedRow[] = [];
  const byStudent = new Map<string, { name: string; email: string; grades: Map<string, number> }>();
  const quarantined = new Set<string>();
  let duplicatesIgnored = 0;

  for (const { record, info } of records) {
    const line = info.lines;
    const candidate = {
      student_id: record.student_id?.trim() ?? '',
      name: sanitizeText(record.name ?? ''),
      email: (record.email ?? '').trim().toLowerCase(),
      subject: sanitizeText(record.subject ?? '', 80),
      grade: parseGrade(record.grade),
    };
    const result = schema.safeParse(candidate);
    if (!result.success) {
      const field = String(result.error.issues[0]?.path[0] ?? 'row');
      rejected.push({ line, reason: reasonFor(field, record[field]), field });
      continue;
    }
    const row = result.data;

    const known = byStudent.get(row.student_id);
    if (!known) {
      byStudent.set(row.student_id, {
        name: row.name,
        email: row.email,
        grades: new Map([[row.subject, row.grade]]),
      });
      continue;
    }
    if (known.email !== row.email) {
      rejected.push({ line, reason: 'EMAIL_MISMATCH', field: 'email' });
      // Identidade ambígua: não envia um boletim parcial para o endereço errado.
      quarantined.add(row.student_id);
      continue;
    }
    const previous = known.grades.get(row.subject);
    if (previous === undefined) {
      known.grades.set(row.subject, row.grade);
    } else if (previous === row.grade) {
      duplicatesIgnored++;
    } else {
      // Notas contraditórias: não dá para saber qual vale. Enviar a errada é pior que atrasar.
      rejected.push({ line, reason: 'DUPLICATE_CONFLICT', field: 'grade' });
      quarantined.add(row.student_id);
    }
  }

  const students: StudentGrades[] = [];
  for (const [studentId, s] of byStudent) {
    if (quarantined.has(studentId)) continue;
    students.push({
      studentId,
      name: s.name,
      email: s.email,
      grades: [...s.grades].map(([subject, grade]) => ({ subject, grade })),
    });
  }

  return {
    students,
    rejected,
    duplicatesIgnored,
    quarantined: [...quarantined],
    totalRows: records.length,
  };
}
