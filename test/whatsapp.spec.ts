import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatalError, RetriableError } from '../src/domain/errors';
import { Notifier } from '../src/domain/ports';
import { NotificationMessage } from '../src/domain/types';
import { parseGradesCsv } from '../src/grades/csv-grade-source';
import { CsvGradeRepository } from '../src/grades/grade-repository';
import { maskPhone } from '../src/grades/sanitize';
import { renderBulletin, renderRemoval } from '../src/notify/render-bulletin';
import { classifyWebhookError, MultiChannelNotifier, WhatsappWebhookNotifier } from '../src/notify/whatsapp-notifier';
import { createLogger } from '../src/observability/logger';
import { RateLimiter } from '../src/resilience/rate-limiter';
import { buildProfile } from '../src/grades/profile';
import { RecordingNotifier, student } from './helpers';

const message = (extra: Partial<NotificationMessage> = {}): NotificationMessage => ({
  idempotencyKey: 'T1:A1:abc',
  to: 'ana@exemplo.pt',
  toName: 'Ana',
  subject: 's',
  text: 't',
  html: 'h',
  phone: '5511999990000',
  whatsappText: 'Olá, Ana!',
  ...extra,
});

describe('WhatsappWebhookNotifier', () => {
  it('envia JSON com segredo e chave de idempotência, sem o e-mail do aluno', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await new WhatsappWebhookNotifier({ url: 'https://n8n.exemplo/webhook/x', secret: 's3', fetchImpl }).send(message());
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://n8n.exemplo/webhook/x');
    expect((init.headers as Record<string, string>)['x-webhook-secret']).toBe('s3');
    expect((init.headers as Record<string, string>)['x-idempotency-key']).toBe('T1:A1:abc');
    expect(JSON.parse(init.body as string)).toEqual({ idempotencyKey: 'T1:A1:abc', phone: '5511999990000', name: 'Ana', text: 'Olá, Ana!' });
  });

  it('sem telefone ou sem texto não chama o webhook', async () => {
    const fetchImpl = jest.fn();
    const n = new WhatsappWebhookNotifier({ url: 'https://x', fetchImpl });
    await n.send(message({ phone: undefined }));
    await n.send(message({ whatsappText: undefined }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifica erros: 5xx/429 retriáveis (com Retry-After), 4xx fatais, rede retriável', async () => {
    expect(classifyWebhookError(503)).toBeInstanceOf(RetriableError);
    expect((classifyWebhookError(429, '2') as RetriableError).retryAfterMs).toBe(2000);
    expect(classifyWebhookError(401)).toBeInstanceOf(FatalError);
    expect(classifyWebhookError(400)).toBeInstanceOf(FatalError);
    const down = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new WhatsappWebhookNotifier({ url: 'https://x', fetchImpl: down }).send(message())).rejects.toBeInstanceOf(RetriableError);
  });
});

describe('MultiChannelNotifier', () => {
  const build = (whatsapp: Notifier, primary: Notifier = new RecordingNotifier()) => ({
    primary,
    notifier: new MultiChannelNotifier({
      primary,
      whatsapp,
      limiter: new RateLimiter({ ratePerSec: 0 }),
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      logger: createLogger('silent'),
    }),
  });

  it('e-mail primeiro, depois WhatsApp', async () => {
    const order: string[] = [];
    const wa: Notifier = { send: async () => void order.push('whatsapp') };
    const email: Notifier = { send: async () => void order.push('email') };
    await build(wa, email).notifier.send(message());
    expect(order).toEqual(['email', 'whatsapp']);
  });

  it('e-mail falhou: sobe o erro e o WhatsApp não é tentado', async () => {
    const wa = { send: jest.fn() };
    const email: Notifier = { send: async () => Promise.reject(new FatalError('rejeitado')) };
    await expect(build(wa, email).notifier.send(message())).rejects.toThrow('rejeitado');
    expect(wa.send).not.toHaveBeenCalled();
  });

  it('WhatsApp falhando não derruba o envio: tenta de novo e desiste sem erro', async () => {
    const wa = { send: jest.fn().mockRejectedValue(new RetriableError('503')) };
    const { notifier, primary } = build(wa);
    await expect(notifier.send(message())).resolves.toBeUndefined();
    expect(wa.send).toHaveBeenCalledTimes(3);
    expect((primary as RecordingNotifier).sent).toHaveLength(1);
  });

  it('WhatsApp com erro fatal: não repete', async () => {
    const wa = { send: jest.fn().mockRejectedValue(new FatalError('401')) };
    await build(wa).notifier.send(message());
    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('mensagem sem telefone: só e-mail', async () => {
    const wa = { send: jest.fn() };
    await build(wa).notifier.send(message({ phone: undefined }));
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe('telefone no CSV e nas mensagens', () => {
  const header = 'student_id,name,email,phone,subject,grade\n';

  it('normaliza formatos comuns e rejeita lixo', () => {
    const r = parseGradesCsv(
      header + 'A1,Ana,a@x.pt,"+55 (11) 99999-0000",Alg,10\nB2,Bia,b@x.pt,,Alg,11\nC3,Cris,c@x.pt,abc,Alg,12\nD4,Duda,d@x.pt,123,Alg,12\n',
      { scaleMax: 20 },
    );
    expect(r.students.map((s) => [s.studentId, s.phone])).toEqual([['A1', '5511999990000'], ['B2', undefined]]);
    expect(r.rejected.map((x) => [x.reason, x.field])).toEqual([['INVALID_FIELD', 'phone'], ['INVALID_FIELD', 'phone']]);
  });

  it('CSV sem a coluna phone continua válido', () => {
    const r = parseGradesCsv('student_id,name,email,subject,grade\nA1,Ana,a@x.pt,Alg,10\n', { scaleMax: 20 });
    expect(r.students[0]!.phone).toBeUndefined();
  });

  it('boletim leva telefone e texto curto de WhatsApp; atualização mostra antes → depois', () => {
    const s = { ...student(), phone: '5511999990000' };
    const profile = buildProfile(s, { scaleMax: 20, passMark: 10 });
    const summary = { strengths: 'a', attention: 'b', nextSteps: 'c' };
    const novo = renderBulletin({ runId: 'T1', period: 'T1', student: s, profile, summary, version: 'v' });
    expect(novo.phone).toBe('5511999990000');
    expect(novo.whatsappText).toContain('já está disponível');
    expect(novo.whatsappText!.length).toBeLessThan(300);
    const upd = renderBulletin({ runId: 'T1', period: 'T1', student: s, profile, summary, version: 'v2', updated: true, changes: [{ subject: 'Matemática', before: 7, after: 14 }] });
    expect(upd.whatsappText).toContain('Matemática: 7 → 14');
    const rem = renderRemoval({ runId: 'T1', period: 'T1', studentId: 'A1', name: 'Ana', email: 'a@x.pt', phone: '5511999990000', previous: [] });
    expect(rem.whatsappText).toContain('removido');
    expect(rem.phone).toBe('5511999990000');
  });

  it('mascara o número nos logs', () => {
    expect(maskPhone('5511999990000')).toBe('55*******0000');
    expect(maskPhone('123')).toBe('***');
  });
});

describe('CsvGradeRepository com telefone', () => {
  let dir: string;
  let csv: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'grades-wa-'));
    csv = join(dir, 'g.csv');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const input = { studentId: 'A1', name: 'Ana', email: 'a@x.pt', grades: [{ subject: 'Alg', grade: 10 }] };

  it('CSV antigo (sem coluna phone) continua sem a coluna enquanto ninguém usa telefone', async () => {
    await writeFile(csv, 'student_id,name,email,subject,grade\nA1,Ana,a@x.pt,Alg,10\n');
    await new CsvGradeRepository(csv, 20).create({ ...input, studentId: 'B2' });
    expect((await readFile(csv, 'utf8')).split('\r\n')[0]).toBe('student_id,name,email,subject,grade');
  });

  it('ao informar telefone a coluna aparece e o número volta normalizado', async () => {
    await writeFile(csv, 'student_id,name,email,subject,grade\nA1,Ana,a@x.pt,Alg,10\n');
    const repo = new CsvGradeRepository(csv, 20);
    await repo.create({ ...input, studentId: 'B2', phone: '+55 (11) 99999-0000' });
    expect((await readFile(csv, 'utf8')).split('\r\n')[0]).toBe('student_id,name,email,phone,subject,grade');
    expect((await repo.get('B2'))?.phone).toBe('5511999990000');
    expect((await repo.get('A1'))?.phone).toBeUndefined();
    await expect(repo.create({ ...input, studentId: 'C3', phone: '12ab' })).rejects.toThrow(/telefone inválido/);
  });
});

describe('workflow n8n (n8n/boletim-whatsapp.json)', () => {
  type Node = { name: string; type: string; parameters: { jsCode?: string } };
  let workflow: { nodes: Node[]; connections: Record<string, { main: { node: string }[][] }> };
  beforeAll(async () => {
    workflow = JSON.parse(await readFile(join(__dirname, '../n8n/boletim-whatsapp.json'), 'utf8'));
  });

  it('todas as conexões apontam para nós que existem', () => {
    const names = new Set(workflow.nodes.map((n) => n.name));
    for (const [from, c] of Object.entries(workflow.connections)) {
      expect(names.has(from)).toBe(true);
      for (const t of c.main.flat()) expect(names.has(t.node)).toBe(true);
    }
  });

  // Executa o código do nó "Validar e deduplicar" com os globais do n8n simulados.
  const runValidate = (req: unknown, store: Record<string, unknown>, env: Record<string, string>) => {
    const code = workflow.nodes.find((n) => n.name === 'Validar e deduplicar')!.parameters.jsCode!;
    const fn = new Function('$input', '$env', '$getWorkflowStaticData', code);
    return (fn({ first: () => ({ json: req }) }, env, () => store) as { json: Record<string, unknown> }[])[0]!.json;
  };
  const env = { N8N_WEBHOOK_SECRET: 'segredo' };
  const req = (over: Record<string, unknown> = {}, headers: Record<string, string> = { 'x-webhook-secret': 'segredo' }) => ({
    headers,
    body: { idempotencyKey: 'k1', phone: '5511999990000', text: 'oi', ...over },
  });

  it('recusa segredo errado (401) e payload inválido (400); aceita o válido', () => {
    expect(runValidate(req({}, { 'x-webhook-secret': 'errado' }), {}, env)).toMatchObject({ status: 'unauthorized', httpCode: 401 });
    expect(runValidate(req(), {}, {})).toMatchObject({ status: 'unauthorized' });
    expect(runValidate(req({ phone: '12' }), {}, env)).toMatchObject({ status: 'invalid', httpCode: 400 });
    expect(runValidate(req({ text: 'x'.repeat(1001) }), {}, env)).toMatchObject({ status: 'invalid' });
    expect(runValidate(req(), {}, env)).toMatchObject({ status: 'ok', phone: '5511999990000', key: 'k1' });
  });

  it('chave já enviada vira "duplicate" (200) sem reenviar', () => {
    expect(runValidate(req(), { sent: { k1: Date.now() } }, env)).toMatchObject({ status: 'duplicate', httpCode: 200 });
  });
});
