import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const num = (def: number) => z.coerce.number().default(def);

const schema = z.object({
  LLM_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_PRICE_INPUT_PER_MTOK: num(1),
  LLM_PRICE_OUTPUT_PER_MTOK: num(5),
  LLM_MAX_OUTPUT_TOKENS: num(300),
  LLM_REQUESTS_PER_SEC: num(5),
  LLM_TIMEOUT_MS: num(20000),
  MAX_RUN_COST_USD: num(5),
  FALLBACK_ON_LLM_FAILURE: bool,
  FAKE_LLM_FAILURE_RATE: num(0),
  FAKE_LLM_LATENCY_MS: num(0),
  NOTIFIER: z.enum(['console', 'smtp', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  /** Plano gratuito do Resend: 2 requisições por segundo. */
  RESEND_REQUESTS_PER_SEC: num(2),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: num(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Secretaria Académica <secretaria@exemplo.pt>'),
  NOTIFY_RATE_PER_SEC: num(10),
  CONCURRENCY: num(5),
  RETRY_ATTEMPTS: num(4),
  RETRY_BASE_MS: num(500),
  RETRY_MAX_MS: num(15000),
  BREAKER_THRESHOLD: num(5),
  BREAKER_COOLDOWN_MS: num(30000),
  GRADE_SCALE_MAX: num(20),
  PASS_MARK: num(10),
  OUTPUT_DIR: z.string().default('./out'),
  LOG_LEVEL: z.string().default('info'),
});

export type AppConfig = z.infer<typeof schema>;

/** Valida o ambiente no boot: falha rápido, com mensagem apontando a variável errada. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // Strings vazias (`VAR=` no .env) contam como "não definida".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${detail}`);
  }
  const cfg = parsed.data;
  if (cfg.NOTIFIER === 'resend' && !cfg.RESEND_API_KEY) {
    throw new Error('Configuração inválida: RESEND_API_KEY é obrigatória com NOTIFIER=resend');
  }
  if (cfg.LLM_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    throw new Error('Configuração inválida: ANTHROPIC_API_KEY é obrigatória com LLM_PROVIDER=anthropic');
  }
  return cfg;
}
