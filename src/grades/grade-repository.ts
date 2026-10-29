import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { FatalError } from '../domain/errors';
import { detectDelimiter } from './csv-grade-source';
import { sanitizeText } from './sanitize';

const HEADER = ['student_id', 'name', 'email', 'subject', 'grade'] as const;

interface RawRow {
  student_id: string;
  name: string;
  email: string;
  subject: string;
  grade: string;
}

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
  }
}

export class StudentNotFoundError extends Error {
  constructor(readonly studentId: string) {
    super(`Aluno ${studentId} não encontrado`);
    this.name = 'StudentNotFoundError';
  }
}

export class StudentExistsError extends Error {
  constructor(readonly studentId: string) {
    super(`Já existe um aluno com a matrícula ${studentId}`);
    this.name = 'StudentExistsError';
  }
}

export interface StudentInput {
  studentId: string;
  name: string;
  email: string;
  grades: { subject: string; grade: number }[];
}

export interface StudentView extends StudentInput {
  /** Há linhas contraditórias (nota ou e-mail) no CSV: editar e salvar resolve o conflito. */
  conflict: boolean;
}

/** Texto que o Excel interpretaria como fórmula ao abrir o CSV. */
const noFormula = (s: string) => !/^[=+@]/.test(s);

const inputSchema = (scaleMax: number) =>
  z.object({
    studentId: z
      .string()
      .trim()
      .min(1, 'matrícula obrigatória')
      .max(32)
      .regex(/^[A-Za-z0-9._-]+$/, 'matrícula só aceita letras, números, ponto, hífen e sublinhado'),
    name: z
      .string()
      .transform((v) => sanitizeText(v))
      .pipe(z.string().min(1, 'nome obrigatório').max(100).refine(noFormula, 'nome não pode começar com = + @')),
    email: z.string().trim().toLowerCase().email('e-mail inválido').max(120),
    grades: z
      .array(
        z.object({
          subject: z
            .string()
            .transform((v) => sanitizeText(v, 80))
            .pipe(z.string().min(1, 'disciplina obrigatória').refine(noFormula, 'disciplina não pode começar com = + @')),
          grade: z.number({ message: 'nota inválida' }).min(0, 'nota abaixo de 0').max(scaleMax, `nota acima de ${scaleMax}`),
        }),
      )
      .min(1, 'informe ao menos uma disciplina')
      .max(40, 'disciplinas demais')
      .superRefine((grades, ctx) => {
        const seen = new Set<string>();
        for (const g of grades) {
          const key = g.subject.toLocaleLowerCase('pt');
          if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `disciplina repetida: ${g.subject}` });
          seen.add(key);
        }
      }),
  });

/**
 * CRUD de alunos/notas sobre o próprio CSV, que continua sendo a fonte da verdade do pipeline.
 * Valida antes de gravar (a UI nunca produz uma linha que o leitor de CSV rejeitaria) e grava de forma
 * atômica (temporário + rename). NÃO tem lock próprio: quem chama serializa as operações.
 */
export class CsvGradeRepository {
  constructor(
    private readonly path: string,
    private readonly scaleMax: number,
  ) {}

  async list(): Promise<StudentView[]> {
    const { rows } = await this.read();
    return groupRows(rows);
  }

  async get(studentId: string): Promise<StudentView | undefined> {
    return (await this.list()).find((s) => s.studentId === studentId);
  }

  async create(input: unknown): Promise<StudentView> {
    const data = this.validate(input);
    const { rows, delimiter } = await this.read();
    if (rows.some((r) => r.student_id === data.studentId)) throw new StudentExistsError(data.studentId);
    await this.write([...rows, ...toRows(data, delimiter)], delimiter);
    return { ...data, conflict: false };
  }

  /** Substitui todo o lançamento do aluno (dados + disciplinas); a matrícula não muda. */
  async replace(studentId: string, input: unknown): Promise<{ before: StudentView; after: StudentView }> {
    const data = this.validate({ ...(input as object), studentId });
    const { rows, delimiter } = await this.read();
    const first = rows.findIndex((r) => r.student_id === studentId);
    if (first < 0) throw new StudentNotFoundError(studentId);
    const before = groupRows(rows).find((s) => s.studentId === studentId)!;
    const rest = rows.filter((r) => r.student_id !== studentId);
    // Mantém a posição original do aluno no arquivo.
    const position = rows.slice(0, first).filter((r) => r.student_id !== studentId).length;
    rest.splice(position, 0, ...toRows(data, delimiter));
    await this.write(rest, delimiter);
    return { before, after: { ...data, conflict: false } };
  }

  async remove(studentId: string): Promise<StudentView> {
    const { rows, delimiter } = await this.read();
    const before = groupRows(rows).find((s) => s.studentId === studentId);
    if (!before) throw new StudentNotFoundError(studentId);
    await this.write(
      rows.filter((r) => r.student_id !== studentId),
      delimiter,
    );
    return before;
  }

  private validate(input: unknown): StudentInput {
    const parsed = inputSchema(this.scaleMax).safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)));
    }
    return parsed.data;
  }

  private async read(): Promise<{ rows: RawRow[]; delimiter: ',' | ';' }> {
    const content = await readFile(this.path, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return `${HEADER.join(',')}\n`;
      throw new FatalError(`Não foi possível ler o ficheiro de notas: ${e.message}`);
    });
    const delimiter = detectDelimiter(content);
    const records = parse(content, {
      delimiter,
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, string | undefined>[];
    const rows = records.map((r) => ({
      student_id: r.student_id ?? '',
      name: r.name ?? '',
      email: r.email ?? '',
      subject: r.subject ?? '',
      grade: r.grade ?? '',
    }));
    return { rows, delimiter };
  }

  private async write(rows: RawRow[], delimiter: ',' | ';'): Promise<void> {
    const cell = (v: string) => (v.includes(delimiter) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const body = [HEADER.join(delimiter), ...rows.map((r) => HEADER.map((h) => cell(r[h])).join(delimiter))].join('\r\n');
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body + '\r\n', 'utf8');
    await rename(tmp, this.path);
  }
}

function toRows(data: StudentInput, delimiter: ',' | ';'): RawRow[] {
  return data.grades.map((g) => ({
    student_id: data.studentId,
    name: data.name,
    email: data.email,
    subject: g.subject,
    // Excel em português espera vírgula decimal quando o arquivo usa ';'.
    grade: delimiter === ';' ? String(g.grade).replace('.', ',') : String(g.grade),
  }));
}

function parseGrade(raw: string): number {
  return Number(raw.trim().replace(',', '.'));
}

/** Agrupa as linhas por aluno. A primeira ocorrência dá nome/e-mail; divergência vira `conflict`. */
function groupRows(rows: RawRow[]): StudentView[] {
  const byId = new Map<string, StudentView>();
  for (const r of rows) {
    if (!r.student_id) continue;
    const email = r.email.trim().toLowerCase();
    let s = byId.get(r.student_id);
    if (!s) {
      s = { studentId: r.student_id, name: r.name, email, grades: [], conflict: false };
      byId.set(r.student_id, s);
    } else if (s.email !== email) {
      s.conflict = true;
    }
    const grade = parseGrade(r.grade);
    const existing = s.grades.find((g) => g.subject === r.subject);
    if (!existing) s.grades.push({ subject: r.subject, grade });
    else if (existing.grade !== grade) s.conflict = true;
  }
  return [...byId.values()];
}
