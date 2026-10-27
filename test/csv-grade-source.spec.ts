import { FatalError } from '../src/domain/errors';
import { parseGradesCsv } from '../src/grades/csv-grade-source';

const opts = { scaleMax: 20 };
const H = 'student_id,name,email,subject,grade\n';

describe('parseGradesCsv', () => {
  it('lê linhas válidas e agrupa por aluno', () => {
    const r = parseGradesCsv(H + 'A1,Ana,a@x.pt,Algoritmos,18\nA1,Ana,a@x.pt,Matemática,12\nA2,Bia,b@x.pt,Algoritmos,9', opts);
    expect(r.students).toHaveLength(2);
    expect(r.students[0]!.grades).toEqual([
      { subject: 'Algoritmos', grade: 18 },
      { subject: 'Matemática', grade: 12 },
    ]);
    expect(r.rejected).toEqual([]);
  });

  it('aceita vírgula decimal', () => {
    const r = parseGradesCsv(H + 'A1,Ana,a@x.pt,Algoritmos,"13,5"', opts);
    expect(r.students[0]!.grades[0]!.grade).toBe(13.5);
  });

  it('rejeita campos ausentes, e-mail inválido e nota fora da escala, sem expor PII', () => {
    const r = parseGradesCsv(
      H + 'A1,Ana,a@x.pt,Algoritmos,\nA2,Bia,nao-e-email,Algoritmos,10\nA3,Caio,c@x.pt,Algoritmos,25\nA4,Dani,d@x.pt,Algoritmos,abc',
      opts,
    );
    expect(r.students).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['MISSING_FIELD', 'INVALID_EMAIL', 'INVALID_GRADE', 'INVALID_GRADE']);
    expect(JSON.stringify(r.rejected)).not.toMatch(/a@x\.pt|Ana|Bia/);
  });

  it('ignora duplicata idêntica e conta', () => {
    const r = parseGradesCsv(H + 'A1,Ana,a@x.pt,Algoritmos,18\nA1,Ana,a@x.pt,Algoritmos,18', opts);
    expect(r.duplicatesIgnored).toBe(1);
    expect(r.students[0]!.grades).toHaveLength(1);
  });

  it('coloca em quarentena o aluno com notas contraditórias', () => {
    const r = parseGradesCsv(
      H + 'A1,Ana,a@x.pt,Algoritmos,12\nA1,Ana,a@x.pt,Algoritmos,17\nA2,Bia,b@x.pt,Algoritmos,9',
      opts,
    );
    expect(r.quarantined).toEqual(['A1']);
    expect(r.students.map((s) => s.studentId)).toEqual(['A2']);
    expect(r.rejected[0]!.reason).toBe('DUPLICATE_CONFLICT');
  });

  it('coloca em quarentena o aluno com e-mails diferentes', () => {
    const r = parseGradesCsv(H + 'A1,Ana,a@x.pt,Algoritmos,12\nA1,Ana,outro@x.pt,Matemática,10', opts);
    expect(r.quarantined).toEqual(['A1']);
    expect(r.students).toEqual([]);
  });

  it('sanitiza texto livre (tags e caracteres de controle)', () => {
    const r = parseGradesCsv(H + 'A1,Ana <b>Silva</b>,a@x.pt,"Alg\u0000oritmos <x>",10', opts);
    expect(r.students[0]!.name).toBe('Ana bSilva/b');
    expect(r.students[0]!.grades[0]!.subject).toBe('Alg oritmos x');
  });

  it('falha de forma fatal e clara com cabeçalhos em falta', () => {
    expect(() => parseGradesCsv('id,nome\n1,Ana', opts)).toThrow(FatalError);
    expect(() => parseGradesCsv('id,nome\n1,Ana', opts)).toThrow(/Cabeçalhos em falta/);
  });
});
