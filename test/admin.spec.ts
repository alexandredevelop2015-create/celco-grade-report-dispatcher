import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { createServer as probe, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config';
import { CsvGradeRepository, StudentExistsError, StudentNotFoundError, ValidationError } from '../src/grades/grade-repository';
import { createLogger } from '../src/observability/logger';
import { AdminService } from '../src/web/admin-service';
import { createUiServer } from '../src/web/server';
import { RecordingNotifier } from './helpers';

const HEADER = 'student_id,name,email,subject,grade\n';
const ana = { studentId: 'A1', name: 'Ana Ribeiro', email: 'ana@exemplo.pt', grades: [{ subject: 'Algoritmos', grade: 18 }, { subject: 'Matemática', grade: 7 }] };

let dir: string;
let csv: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grades-ui-'));
  csv = join(dir, 'grades.csv');
  await writeFile(csv, HEADER);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('CsvGradeRepository', () => {
  const repo = () => new CsvGradeRepository(csv, 20);

  it('inclui, lê, altera e exclui um aluno', async () => {
    await repo().create(ana);
    expect(await repo().list()).toEqual([{ ...ana, conflict: false }]);

    const { before, after } = await repo().replace('A1', { ...ana, grades: [{ subject: 'Algoritmos', grade: 19 }] });
    expect(before.grades).toHaveLength(2);
    expect(after.grades).toEqual([{ subject: 'Algoritmos', grade: 19 }]);

    await repo().remove('A1');
    expect(await repo().list()).toEqual([]);
  });

  it('rejeita matrícula repetida, aluno inexistente e dados inválidos sem tocar no arquivo', async () => {
    await repo().create(ana);
    const before = await readFile(csv, 'utf8');
    await expect(repo().create(ana)).rejects.toBeInstanceOf(StudentExistsError);
    await expect(repo().replace('ZZ', ana)).rejects.toBeInstanceOf(StudentNotFoundError);
    await expect(repo().remove('ZZ')).rejects.toBeInstanceOf(StudentNotFoundError);
    await expect(repo().create({ ...ana, studentId: 'B2', email: 'não-é-email' })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo().create({ ...ana, studentId: 'B2', grades: [{ subject: 'X', grade: 21 }] })).rejects.toThrow(/acima de 20/);
    await expect(repo().create({ ...ana, studentId: 'B2', grades: [] })).rejects.toThrow(/ao menos uma/);
    await expect(repo().create({ ...ana, studentId: 'B2', grades: [{ subject: 'X', grade: 1 }, { subject: 'x', grade: 2 }] })).rejects.toThrow(/repetida/);
    await expect(repo().create({ ...ana, studentId: 'B2', name: '=HYPERLINK("http://x")' })).rejects.toThrow(/começar com/);
    expect(await readFile(csv, 'utf8')).toBe(before);
  });

  it('preserva o separador ";" e a vírgula decimal do arquivo', async () => {
    await writeFile(csv, 'student_id;name;email;subject;grade\nA1;Ana;ana@exemplo.pt;Algoritmos;17,5\n');
    await repo().create({ ...ana, studentId: 'B2', grades: [{ subject: 'Física', grade: 12.5 }] });
    const text = await readFile(csv, 'utf8');
    expect(text).toContain('A1;Ana;ana@exemplo.pt;Algoritmos;17,5');
    expect(text).toContain('B2;Ana Ribeiro;ana@exemplo.pt;Física;12,5');
  });

  it('mantém a posição do aluno no arquivo e marca conflito em linhas contraditórias', async () => {
    await writeFile(csv, HEADER + 'A1,Ana,a@x.pt,Alg,10\nB2,Bia,b@x.pt,Alg,11\nA1,Ana,a@x.pt,Alg,15\n');
    expect((await repo().get('A1'))?.conflict).toBe(true);
    await repo().replace('A1', { name: 'Ana', email: 'a@x.pt', grades: [{ subject: 'Alg', grade: 15 }] });
    expect((await repo().list()).map((s) => [s.studentId, s.conflict])).toEqual([['A1', false], ['B2', false]]);
    expect((await readFile(csv, 'utf8')).split('\r\n')[1]).toContain('A1,Ana');
  });

  it('escapa aspas e vírgulas no nome', async () => {
    await repo().create({ ...ana, name: 'Silva, Ana "Nana"' });
    expect((await repo().get('A1'))?.name).toBe('Silva, Ana "Nana"');
  });
});

describe('AdminService', () => {
  const build = (env: Record<string, string> = {}) => {
    const notifier = new RecordingNotifier();
    const config = loadConfig({ NOTIFIER: 'console', OUTPUT_DIR: join(dir, 'out'), ADMIN_EMAIL: 'secretaria@exemplo.pt', RETRY_BASE_MS: '1', LOG_LEVEL: 'silent', ...env });
    return { notifier, admin: new AdminService({ config, csvPath: csv, period: 'T1', notifier }) };
  };
  const to = (n: RecordingNotifier) => n.sent.map((m) => `${m.to}|${m.subject}`);

  it('inclusão: avisa o aluno (boletim) e a secretaria (auditoria)', async () => {
    const { admin, notifier } = build();
    const r = await admin.create(ana, true);
    expect(to(notifier)).toEqual(['ana@exemplo.pt|Boletim T1', 'secretaria@exemplo.pt|[Auditoria] Aluno incluído · A1 · T1']);
    expect(r.studentNotice).toMatch(/boletim enviado para ana@exemplo.pt/);
    expect(r.audit.status).toBe('sent');
  });

  it('alteração de nota: reenvia o boletim atualizado com antes/depois e audita', async () => {
    const { admin, notifier } = build();
    await admin.create(ana, true);
    notifier.sent = [];
    const r = await admin.update('A1', { ...ana, grades: [{ subject: 'Algoritmos', grade: 18 }, { subject: 'Matemática', grade: 14 }] }, true);
    expect(to(notifier)).toEqual(['ana@exemplo.pt|Boletim T1 (atualizado)', 'secretaria@exemplo.pt|[Auditoria] Notas/dados alterados · A1 · T1']);
    expect(notifier.sent[0]!.text).toContain('Matemática: 7 → 14');
    expect(notifier.sent[1]!.text).toContain('Matemática: 7 → 14');
    expect(r.studentNotice).toMatch(/atualizado enviado/);
  });

  it('edição sem mudança real: nenhum e-mail ao aluno, só a auditoria', async () => {
    const { admin, notifier } = build();
    await admin.create(ana, true);
    notifier.sent = [];
    const r = await admin.update('A1', ana, true);
    expect(to(notifier)).toEqual(['secretaria@exemplo.pt|[Auditoria] Notas/dados alterados · A1 · T1']);
    expect(r.studentNotice).toMatch(/nenhum e-mail/);
  });

  it('exclusão: avisa o aluno que o lançamento foi anulado e audita', async () => {
    const { admin, notifier } = build();
    await admin.create(ana, true);
    notifier.sent = [];
    const r = await admin.remove('A1', true);
    expect(to(notifier)).toEqual(['ana@exemplo.pt|Boletim T1 (lançamento removido)', 'secretaria@exemplo.pt|[Auditoria] Aluno excluído · A1 · T1']);
    expect(r.studentNotice).toMatch(/remoção enviado/);
    expect(await admin.repo.list()).toEqual([]);
  });

  it('excluir quem nunca recebeu boletim não manda e-mail ao aluno', async () => {
    const { admin, notifier } = build();
    await admin.create(ana, false);
    expect(to(notifier)).toEqual(['secretaria@exemplo.pt|[Auditoria] Aluno incluído · A1 · T1']);
    notifier.sent = [];
    const r = await admin.remove('A1', true);
    expect(to(notifier)).toEqual(['secretaria@exemplo.pt|[Auditoria] Aluno excluído · A1 · T1']);
    expect(r.studentNotice).toMatch(/nunca recebeu boletim/);
  });

  it('notify=false: grava e audita, mas o aluno só é avisado na próxima execução', async () => {
    const { admin, notifier } = build();
    const r = await admin.create(ana, false);
    expect(r.studentNotice).toMatch(/não enviado/);
    notifier.sent = [];
    await admin.dispatch();
    expect(to(notifier)).toContain('ana@exemplo.pt|Boletim T1');
  });

  it('sem ADMIN_EMAIL a auditoria é pulada, mas o aluno continua sendo avisado', async () => {
    const notifier = new RecordingNotifier();
    const config = loadConfig({ NOTIFIER: 'console', OUTPUT_DIR: join(dir, 'out'), LOG_LEVEL: 'silent' });
    const r = await new AdminService({ config, csvPath: csv, period: 'T1', notifier }).create(ana, true);
    expect(r.audit.status).toBe('skipped');
    expect(to(notifier)).toEqual(['ana@exemplo.pt|Boletim T1']);
  });

  it('falha do canal de e-mail não perde a alteração: relata falha no aluno e na auditoria', async () => {
    const { admin, notifier } = build({ RETRY_ATTEMPTS: '1' });
    const { FatalError } = await import('../src/domain/errors');
    notifier.failWith = new FatalError('endereço rejeitado');
    notifier.failTimes = 99;
    const r = await admin.create(ana, true);
    expect(r.studentNotice).toMatch(/FALHA/);
    expect(r.audit.status).toBe('failed');
    expect((await admin.repo.list())).toHaveLength(1);
  });

  it('snapshot mostra situação de cada aluno e o relatório', async () => {
    const { admin } = build();
    await admin.create(ana, true);
    await admin.create({ ...ana, studentId: 'B2', name: 'Bia', email: 'bia@exemplo.pt' }, false);
    const snap = await admin.snapshot();
    expect(snap.students.map((s) => [s.studentId, s.status])).toEqual([['A1', 'ENVIADO'], ['B2', 'PENDENTE']]);
    expect(snap.report?.result.sent).toBe(1);
    expect(snap.changes.length).toBeGreaterThan(0);
  });
});

describe('servidor HTTP', () => {
  let server: Server | undefined;
  let base: string;
  let notifier: RecordingNotifier;

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = probe().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(port));
      });
    });
  }

  beforeEach(async () => {
    notifier = new RecordingNotifier();
    const config = loadConfig({ NOTIFIER: 'console', OUTPUT_DIR: join(dir, 'out'), ADMIN_EMAIL: 'secretaria@exemplo.pt', LOG_LEVEL: 'silent' });
    const port = await freePort();
    server = createUiServer(new AdminService({ config, csvPath: csv, period: 'T1', notifier }), createLogger('silent'), port);
    await new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(() => new Promise<void>((r) => server!.close(() => r())));

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('serve a página com CSP estrita', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('Despachante de Boletins');
  });

  it('CRUD completo pela API', async () => {
    expect((await json('POST', '/api/students', ana)).status).toBe(201);
    expect((await json('POST', '/api/students', ana)).status).toBe(409);
    expect((await json('PUT', '/api/students/A1', { ...ana, name: 'Ana R.' })).status).toBe(200);
    const state = (await (await fetch(base + '/api/state')).json()) as { students: { name: string }[] };
    expect(state.students[0]!.name).toBe('Ana R.');
    expect((await json('DELETE', '/api/students/A1', {})).status).toBe(200);
    expect((await json('DELETE', '/api/students/A1', {})).status).toBe(404);
  });

  it('valida entrada (400 com detalhes), tipo de conteúdo (415) e rota (404)', async () => {
    const bad = await json('POST', '/api/students', { ...ana, email: 'x' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: string[] }).issues.join()).toMatch(/e-mail/);
    const res = await fetch(base + '/api/students', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
    expect((await fetch(base + '/api/nada')).status).toBe(404);
    expect((await fetch(base + '/../package.json')).status).toBe(404);
  });

  it('bloqueia origem externa (CSRF) e Host forjado (DNS rebinding)', async () => {
    expect((await json('POST', '/api/students', ana, { Origin: 'http://evil.example' })).status).toBe(403);
    const forged = await new Promise<number>((resolve, reject) => {
      const http = require('node:http') as typeof import('node:http');
      http.get(base + '/api/state', { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
    });
    expect(forged).toBe(403);
  });
});
