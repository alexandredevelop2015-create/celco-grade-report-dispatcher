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

const USAGE = `Uso: node dist/cli.js dispatch --file <notas.csv> --period <2026-1S> [opções]

  --file <caminho>       CSV de notas (student_id,name,email,subject,grade)
  --period <rótulo>      Período letivo; identifica a execução e a idempotência (ex.: 2026-1S)
  --validate-only        Só valida o CSV e gera o relatório, sem LLM nem envio
  --resend <ids>         Reenvia estes alunos (separe por vírgula) mesmo sem mudança nas notas
  --fresh                Apaga o estado do período antes de rodar (reenvia tudo; use em demos)
  --concurrency <n>      Alunos em paralelo (padrão: CONCURRENCY do ambiente)
`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      period: { type: 'string' },
      'validate-only': { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      resend: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

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
      resend: (values.resend ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean),
      outputDir: config.OUTPUT_DIR,
      model: generator.model,
    });
    process.stderr.write('\n' + renderReportMarkdown(report));
    return report.result.failed > 0 ? 1 : 0;
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
