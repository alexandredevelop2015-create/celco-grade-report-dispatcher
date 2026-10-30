import { BudgetExceededError, FatalError, RetriableError } from '../src/domain/errors';
import { SummaryGenerator } from '../src/domain/ports';
import { buildProfile, profileCacheKey } from '../src/grades/profile';
import { classifyLlmError } from '../src/llm/anthropic-summary-generator';
import { BudgetGuard, estimateCostUsd } from '../src/llm/cost';
import { buildFallbackSummary } from '../src/llm/fallback-summary';
import { FakeSummaryGenerator } from '../src/llm/fake-summary-generator';
import { parseSummary } from '../src/llm/parse-summary';
import { buildUserPrompt, MAX_PROMPT_SUBJECTS, truncateProfile } from '../src/llm/prompt';
import { student } from './helpers';

const rules = { scaleMax: 20, passMark: 10 };
const profile = buildProfile(student(), rules);

describe('perfil e prompt', () => {
  it('classifica disciplinas e calcula a média', () => {
    expect(profile.subjects).toEqual([
      { subject: 'Algoritmos', grade: 18, status: 'strong' },
      { subject: 'Matemática', grade: 7, status: 'attention' },
    ]);
    expect(profile.average).toBe(12.5);
  });

  it('não envia PII ao LLM', () => {
    const prompt = buildUserPrompt(profile);
    expect(prompt).not.toMatch(/Ana|ana@exemplo|A1/);
    expect(prompt.startsWith('<dados>')).toBe(true);
  });

  it('trunca o contexto: mantém disciplinas em atenção primeiro e informa as omitidas', () => {
    const total = MAX_PROMPT_SUBJECTS + 5;
    const big = {
      ...profile,
      subjects: Array.from({ length: total }, (_, i) =>
        i === total - 1
          ? { subject: 'Crítica', grade: 3, status: 'attention' as const }
          : { subject: `D${i}`, grade: 18, status: 'strong' as const },
      ),
    };
    const out = truncateProfile(big);
    expect(out.subjects).toHaveLength(MAX_PROMPT_SUBJECTS);
    expect(out.omitted).toBe(5);
    expect(out.subjects[0]?.subject).toBe('Crítica');
    expect(out.average).toBe(big.average);
    expect(buildUserPrompt(big)).toContain('"omitted":5');
    expect(truncateProfile(profile)).toBe(profile);
  });

  it('gera a mesma chave de cache para perfis iguais e outra ao mudar modelo/prompt', () => {
    const other = buildProfile({ ...student('Z9'), name: 'Outra Pessoa' }, rules);
    expect(profileCacheKey(other, 'm', 'v1')).toBe(profileCacheKey(profile, 'm', 'v1'));
    expect(profileCacheKey(profile, 'm2', 'v1')).not.toBe(profileCacheKey(profile, 'm', 'v1'));
    expect(profileCacheKey(profile, 'm', 'v2')).not.toBe(profileCacheKey(profile, 'm', 'v1'));
  });
});

describe('parseSummary', () => {
  const ok = { strengths: 'a', attention: 'b', nextSteps: 'c' };

  it('aceita JSON, inclusive dentro de cerca de código', () => {
    expect(parseSummary(JSON.stringify(ok))).toEqual(ok);
    expect(parseSummary('```json\n' + JSON.stringify(ok) + '\n```')).toEqual(ok);
  });

  it('trata saída fora do contrato como falha transitória (vale nova tentativa)', () => {
    expect(() => parseSummary('Claro! Aqui vai o resumo')).toThrow(RetriableError);
    expect(() => parseSummary('{"strengths":"a"}')).toThrow(RetriableError);
  });
});

describe('classifyLlmError', () => {
  it.each([429, 500, 503, 529, 408])('status %i é retriável', (status) => {
    expect(classifyLlmError({ status, message: 'x' })).toBeInstanceOf(RetriableError);
  });
  it.each([400, 401, 403, 404, 422])('status %i é fatal', (status) => {
    expect(classifyLlmError({ status, message: 'x' })).toBeInstanceOf(FatalError);
  });
  it('erro sem status (rede/timeout) é retriável', () => {
    expect(classifyLlmError(new Error('socket hang up'))).toBeInstanceOf(RetriableError);
  });
  it('lê Retry-After em segundos', () => {
    const e = classifyLlmError({ status: 429, message: 'x', headers: { 'retry-after': '7' } }) as RetriableError;
    expect(e.retryAfterMs).toBe(7000);
  });
});

describe('custo e orçamento', () => {
  it('calcula custo por milhão de tokens', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 200_000 }, { inputPerMTok: 1, outputPerMTok: 5 })).toBe(2);
  });

  it('bloqueia reservas que estourem o teto e libera o reservado', () => {
    const budget = new BudgetGuard(1);
    const release = budget.reserve(0.8);
    expect(() => budget.reserve(0.3)).toThrow(BudgetExceededError);
    release();
    expect(() => budget.reserve(0.3)).not.toThrow();
  });
});

describe('fallback determinístico', () => {
  it('cita disciplinas fortes e fracas sem LLM', () => {
    const s = buildFallbackSummary(profile);
    expect(s.strengths).toContain('Algoritmos');
    expect(s.attention).toContain('Matemática');
  });
});

/** Teste de contrato: toda implementação de SummaryGenerator deve cumprir isto. */
describe.each<[string, () => SummaryGenerator]>([['FakeSummaryGenerator', () => new FakeSummaryGenerator()]])(
  'contrato SummaryGenerator: %s',
  (_name, make) => {
    it('devolve resumo válido, uso de tokens não negativo e o modelo', async () => {
      const g = make();
      const r = await g.generate(profile);
      expect(parseSummary(JSON.stringify(r.summary))).toEqual(r.summary);
      expect(r.usage.inputTokens).toBeGreaterThan(0);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
      expect(r.model).toBe(g.model);
    });
  },
);
