import { FatalError, RetriableError } from '../src/domain/errors';
import { NotificationMessage } from '../src/domain/types';
import { classifyResendError, ResendNotifier } from '../src/notify/resend-notifier';

const message: NotificationMessage = {
  idempotencyKey: '2026-1S:A1:abcd1234',
  to: 'ana@exemplo.pt',
  toName: 'Ana "Maria" <Ribeiro>',
  subject: 'Boletim 2026-1S',
  text: 'texto',
  html: '<p>html</p>',
};

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));

const notifier = (fetchImpl: jest.Mock) => new ResendNotifier({ apiKey: 're_chave_secreta', from: 'Secretaria <noreply@exemplo.pt>', fetchImpl });

describe('ResendNotifier', () => {
  it('envia para a API com Bearer, Idempotency-Key e destinatário sanitizado', async () => {
    const fetchImpl = reply(200, { id: 'abc' });
    await notifier(fetchImpl).send(message);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer re_chave_secreta');
    expect(init.headers['idempotency-key']).toBe('2026-1S:A1:abcd1234');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: 'Secretaria <noreply@exemplo.pt>', subject: 'Boletim 2026-1S', text: 'texto', html: '<p>html</p>' });
    expect(body.to).toEqual(['Ana Maria Ribeiro <ana@exemplo.pt>']);
  });

  it.each([429, 500, 503])('status %i é retriável', async (status) => {
    await expect(notifier(reply(status, { name: 'x', message: 'y' })).send(message)).rejects.toBeInstanceOf(RetriableError);
  });

  it.each([400, 401, 403, 422])('status %i é fatal', async (status) => {
    await expect(notifier(reply(status, { name: 'validation_error', message: 'domínio não verificado' })).send(message)).rejects.toBeInstanceOf(FatalError);
  });

  it('respeita Retry-After do 429', async () => {
    const error = await notifier(reply(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '3' })).send(message).catch((e: unknown) => e);
    expect((error as RetriableError).retryAfterMs).toBe(3000);
  });

  it('falha de rede é retriável e a mensagem não vaza a chave', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed: Bearer re_chave_secreta'));
    const error = (await notifier(fetchImpl).send(message).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(RetriableError);
    expect(error.message).not.toContain('re_chave_secreta');
  });

  it('a mensagem de erro de API não contém a chave', async () => {
    const error = (await notifier(reply(401, { name: 'restricted_api_key', message: 'chave restrita' })).send(message).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('restricted_api_key');
    expect(error.message).not.toContain('re_chave_secreta');
  });
});

describe('classifyResendError (idempotência)', () => {
  it('409 de requisição concorrente é retriável; 409 de payload diferente é fatal', () => {
    expect(classifyResendError(409, { name: 'concurrent_idempotent_requests' })).toBeInstanceOf(RetriableError);
    expect(classifyResendError(409, { name: 'invalid_idempotent_request' })).toBeInstanceOf(FatalError);
  });
});
