import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FatalError } from '../domain/errors';
import { StudentExistsError, StudentNotFoundError, ValidationError } from '../grades/grade-repository';
import { AppLogger } from '../observability/logger';
import { AdminService } from './admin-service';

const PUBLIC_DIR = resolve(__dirname, '../../public');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

/**
 * API JSON + página estática, só com `node:http` (zero dependências novas). Escuta apenas em 127.0.0.1 e não tem
 * login: é uma ferramenta de secretaria local. Por isso valida `Host`/`Origin` (contra DNS rebinding e CSRF) e
 * exige `Content-Type: application/json` nas escritas (um <form> de outro site não consegue enviar isso).
 */
export function createUiServer(admin: AdminService, logger: AppLogger, port: number): Server {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Content-Type deve ser application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo grande demais');
      chunks.push(chunk as Buffer);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      throw new HttpError(400, 'JSON inválido');
    }
  };

  const notifyFlag = (body: unknown) => (body as { notify?: unknown }).notify !== false;

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && STATIC[url.pathname]) {
      const asset = STATIC[url.pathname]!;
      const content = await readFile(join(PUBLIC_DIR, asset.file));
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(content);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Não encontrado');

    if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, await admin.snapshot());

    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHosts.has(new URL(origin).host)) throw new HttpError(403, 'Origem não permitida');
    }

    if (method === 'POST' && url.pathname === '/api/students') {
      const body = await readBody(req);
      return send(res, 201, await admin.create(body, notifyFlag(body)));
    }
    if (method === 'POST' && url.pathname === '/api/dispatch') {
      const body = (await readBody(req)) as { resend?: unknown };
      const resend = Array.isArray(body.resend) ? body.resend.filter((v): v is string => typeof v === 'string') : [];
      return send(res, 200, await admin.dispatch(resend));
    }
    const student = /^\/api\/students\/([A-Za-z0-9._-]{1,32})$/.exec(url.pathname);
    if (student && method === 'PUT') {
      const body = await readBody(req);
      return send(res, 200, await admin.update(student[1]!, body, notifyFlag(body)));
    }
    if (student && method === 'DELETE') {
      const body = await readBody(req);
      return send(res, 200, await admin.remove(student[1]!, notifyFlag(body)));
    }
    throw new HttpError(404, 'Não encontrado');
  };

  return createServer((req, res) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'Host não permitido' });
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, issues: error.issues });
      if (error instanceof ValidationError) return send(res, 400, { error: 'Dados inválidos', issues: error.issues });
      if (error instanceof StudentNotFoundError) return send(res, 404, { error: error.message });
      if (error instanceof StudentExistsError) return send(res, 409, { error: error.message });
      if (error instanceof FatalError) return send(res, 422, { error: error.message });
      logger.error({ event: 'ui_error', err: error instanceof Error ? (error.stack ?? error.message) : String(error) }, 'erro inesperado na interface');
      send(res, 500, { error: 'Erro interno. Veja o log do servidor.' });
    });
  });
}
