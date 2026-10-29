import { createHash } from 'node:crypto';
import { GradeChange, GradeEntry, GradeProfile, StudentGrades, SubjectStatus } from '../domain/types';

export interface AcademicRules {
  scaleMax: number;
  passMark: number;
}

/**
 * Notas arredondadas ao inteiro: é a escala usual (0-20) e aumenta a taxa de acerto do cache,
 * já que perfis parecidos geram o mesmo texto.
 */
export function buildProfile(student: StudentGrades, rules: AcademicRules): GradeProfile {
  const strongFrom = rules.scaleMax * 0.8;
  const subjects = student.grades
    .map(({ subject, grade }) => {
      const rounded = Math.round(grade);
      const status: SubjectStatus =
        rounded >= strongFrom ? 'strong' : rounded < rules.passMark ? 'attention' : 'ok';
      return { subject, grade: rounded, status };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject, 'pt'));
  const average = subjects.reduce((sum, s) => sum + s.grade, 0) / subjects.length;
  return {
    scale: rules.scaleMax,
    passMark: rules.passMark,
    average: Math.round(average * 10) / 10,
    subjects,
  };
}

/** Chave de cache: perfil + modelo + versão do prompt. Sem PII, então pode ser persistida. */
export function profileCacheKey(profile: GradeProfile, model: string, promptVersion: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ profile, model, promptVersion }))
    .digest('hex');
}

/**
 * Impressão digital do que vai no boletim (nome, e-mail e notas por disciplina, em ordem estável).
 * Se mudar entre duas execuções do mesmo período, o aluno recebe um boletim atualizado.
 */
export function studentDataHash(student: StudentGrades): string {
  const grades = [...student.grades].sort((a, b) => a.subject.localeCompare(b.subject, 'pt'));
  return createHash('sha256')
    .update(JSON.stringify({ name: student.name, email: student.email, grades }))
    .digest('hex');
}

/** O que mudou entre o último boletim enviado e as notas atuais (sem `before` = disciplina nova). */
export function diffGrades(before: GradeEntry[] | undefined, after: GradeEntry[]): GradeChange[] {
  const prev = new Map((before ?? []).map((g) => [g.subject, g.grade]));
  const next = new Map(after.map((g) => [g.subject, g.grade]));
  const changes: GradeChange[] = [];
  for (const [subject, grade] of next) {
    const old = prev.get(subject);
    if (old === undefined) changes.push({ subject, after: grade });
    else if (old !== grade) changes.push({ subject, before: old, after: grade });
  }
  for (const [subject, grade] of prev) if (!next.has(subject)) changes.push({ subject, before: grade });
  return changes.sort((a, b) => a.subject.localeCompare(b.subject, 'pt'));
}
