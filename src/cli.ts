import 'reflect-metadata';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { SummaryGenerator, TOKENS } from './domain/ports';
import { DispatcherService } from './pipeline/dispatcher.service';
import { renderReportMarkdown } from './pipeline/report';
import { createLogger } from './observability/logger';
import { AdminService } from './web/admin-service';
import { createUiServer } from './web/server';

const USAGE = `Uso: node dist/cli.js dispatch --file <notas.csv> --period <2026-1S> [opções]

  --file <caminho>       CSV de notas (student_id,name,email,subject,grade)
  --period <rótulo>      Período letivo; identifica a execução e a idempotência (ex.: 2026-1S)
  --validate-only        Só valida o CSV e gera o relatório, sem LLM nem envio
  --resend <ids>         Reenvia estes alunos (separe por vírgula) mesmo sem mudança nas notas
  --confirm-removals     Libera o aviso de remoção quando a trava de segurança bloqueia (muitos alunos sumiram do CSV)
  --fresh                Apaga o estado do período antes de rodar (reenvia tudo; use em demos)
  --concurrency <n>      Alunos em paralelo (padrão: CONCURRENCY do ambiente)

Interface web (cadastro de alunos/notas, envio e acompanhamento):
  node dist/cli.js serve --file <notas.csv> --period <2026-1S> [--port 3000]
`;

/** Sobe a interface web e fica de pé até Ctrl+C. */
async function serve(file: string, period: string, portArg?: string): Promise<number> {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(period)) {
    process.stderr.write('--period deve ter só letras, números, ponto, hífen ou sublinhado (máx. 40).\n');
    return 2;
  }
  const config = loadConfig(process.env);
  const port = portArg ? Number(portArg) : config.UI_PORT;
  const logger = createLogger(config.LOG_LEVEL);
  const server = createUiServer(new AdminService({ config, csvPath: file, period }), logger, port);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`Interface em http://localhost:${port}  (período ${period}, notificador ${config.NOTIFIER}, auditoria ${config.ADMIN_EMAIL ? 'ligada' : 'desligada'})\n`);
  await new Promise<void>((resolve) => process.once('SIGINT', resolve).once('SIGTERM', resolve));
  server.close();
  return 0;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      period: { type: 'string' },
      'validate-only': { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      'confirm-removals': { type: 'boolean', default: false },
      resend: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (positionals[0] === 'serve' && values.file && values.period && !values.help) return serve(values.file, values.period, values.port);

  if (values.help || positionals[0] !== 'dispatch' || !values.file || !values.period) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(values.period)) {
    process.stderr.write('--period deve ter só letras, números, ponto, hífen ou sublinhado (máx. 40).\n');
    return 2;
  }

  const config = loadConfig(process.env);
  if (values.fresh) await rm(join(config.OUTPUT_DIR, values.period), { recursive: true, force: true });
  const app = await NestFactory.createApplicationContext(
    AppModule.register({
      config,
      csvPath: values.file,
      statePath: join(config.OUTPUT_DIR, values.period, 'state.json'),
    }),
    { logger: ['error', 'warn'] },
  );

  try {
    const generator = app.get<SummaryGenerator>(TOKENS.SUMMARY_GENERATOR);
    const report = await app.get(DispatcherService).run({
      runId: values.period,
      period: values.period,
      concurrency: values.concurrency ? Number(values.concurrency) : config.CONCURRENCY,
      validateOnly: values['validate-only'],
      confirmRemovals: values['confirm-removals'],
      resend: (values.resend ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean),
      outputDir: config.OUTPUT_DIR,
      model: generator.model,
    });
    process.stderr.write('\n' + renderReportMarkdown(report));
    return report.result.failed > 0 || report.result.removalsBlocked > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Erro esperado de entrada (FatalError, config) -> mensagem curta; o resto mostra a pilha.
    const expected = error instanceof Error && ['FatalError', 'Error'].includes(error.name) && /Configuração|CSV|Cabeçalhos|ficheiro/.test(error.message);
    process.stderr.write(`Erro: ${error instanceof Error ? (expected ? error.message : (error.stack ?? error.message)) : String(error)}\n`);
    process.exit(2);
  },
);
