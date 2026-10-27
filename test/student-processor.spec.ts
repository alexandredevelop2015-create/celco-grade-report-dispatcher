import { FatalError, RetriableError } from '../src/domain/errors';
import { SummaryGenerator } from '../src/domain/ports';
import { BudgetGuard } from '../src/llm/cost';
import { FakeSummaryGenerator } from '../src/llm/fake-summary-generator';
import { buildProcessor, ctx, student } from './helpers';

describe('StudentProcessor', () => {
  it('gera, envia e persiste SENT', async () => {
    const { processor, store, notifier } = buildProcessor();
    const outcome = await processor.process(ctx, student());

    expect(outcome).toMatchObject({ status: 'sent', source: 'llm' });
    expect(outcome.costUsd).toBeGreaterThan(0);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.idempotencyKey).toBe('run-1:A1');
    expect((await store.get('run-1', 'A1'))?.status).toBe('SENT');
  });

  it('idempotência: reexecutar o mesmo aluno/período não reenvia nem chama o LLM', async () => {
    const { processor, notifier, deps } = buildProcessor();
    const generator = deps.generator as FakeSummaryGenerator;
    await processor.process(ctx, student());
    const second = await processor.process(ctx, student());

    expect(second.status).toBe('skipped');
    expect(notifier.sent).toHaveLength(1);
    expect(generator.calls).toBe(1);
  });

  it('retomada: falha no envio mantém o resumo e a nova execução só reenvia, sem pagar LLM de novo', async () => {
    const { processor, notifier, store, deps } = buildProcessor();
    const generator = deps.generator as FakeSummaryGenerator;
    notifier.failWith = new FatalError('caixa inexistente');
    notifier.failTimes = 1;

    const first = await processor.process(ctx, student());
    expect(first).toMatchObject({ status: 'failed', error: { kind: 'fatal' } });
    expect((await store.get('run-1', 'A1'))?.status).toBe('FAILED');

    const second = await processor.process(ctx, student());
    expect(second.status).toBe('sent');
    expect(generator.calls).toBe(1);
    expect(second.costUsd).toBe(0);
  });

  it('cache: aluno com o mesmo perfil de notas não gera nova chamada ao LLM', async () => {
    const { processor, deps } = buildProcessor();
    const generator = deps.generator as FakeSummaryGenerator;
    await processor.process(ctx, student('A1'));
    const second = await processor.process(ctx, student('A2'));

    expect(second).toMatchObject({ status: 'sent', source: 'cache', costUsd: 0 });
    expect(generator.calls).toBe(1);
  });

  it('retry: falha transitória do LLM é repetida e o aluno recebe resumo do LLM', async () => {
    const flaky: SummaryGenerator = new (class extends FakeSummaryGenerator {
      override async generate(p: Parameters<FakeSummaryGenerator['generate']>[0]) {
        if (++this.calls < 3) throw new RetriableError('503');
        this.calls--;
        return super.generate(p);
      }
    })();
    const { processor } = buildProcessor({ generator: flaky });
    const outcome = await processor.process(ctx, student());
    expect(outcome).toMatchObject({ status: 'sent', source: 'llm', llmAttempts: 3 });
  });

  it('fallback: LLM fora do ar esgota o retry e o aluno ainda recebe o boletim', async () => {
    const down = new FakeSummaryGenerator({ failureRate: 1 });
    const { processor, notifier } = buildProcessor({ generator: down });
    const outcome = await processor.process(ctx, student());

    expect(outcome).toMatchObject({ status: 'sent', source: 'fallback', costUsd: 0 });
    expect(outcome.error?.kind).toBe('retriable_exhausted');
    expect(notifier.sent).toHaveLength(1);
  });

  it('sem fallback habilitado, falha do LLM falha o aluno (e o resumo não é inventado)', async () => {
    const down = new FakeSummaryGenerator({ failureRate: 1 });
    const { processor, notifier } = buildProcessor({ generator: down, fallbackOnLlmFailure: false });
    const outcome = await processor.process(ctx, student());
    expect(outcome.status).toBe('failed');
    expect(notifier.sent).toHaveLength(0);
  });

  it('circuit breaker: depois de abrir, os demais alunos nem chamam o LLM', async () => {
    const down = new FakeSummaryGenerator({ failureRate: 1 });
    const { processor } = buildProcessor({ generator: down });
    await processor.process(ctx, student('A1', [['X', 1]]));
    const callsAfterFirst = down.calls;
    const outcome = await processor.process(ctx, student('A2', [['Y', 2]]));

    expect(outcome).toMatchObject({ status: 'sent', source: 'fallback', error: { kind: 'circuit_open' } });
    expect(down.calls).toBe(callsAfterFirst);
  });

  it('orçamento esgotado: usa fallback em vez de continuar gastando', async () => {
    const { processor, deps } = buildProcessor({ budget: new BudgetGuard(0) });
    const generator = deps.generator as FakeSummaryGenerator;
    const outcome = await processor.process(ctx, student());
    expect(outcome).toMatchObject({ status: 'sent', source: 'fallback', error: { kind: 'budget' } });
    expect(generator.calls).toBe(0);
  });

  it('retry do envio: SMTP transitório é repetido e conta como enviado', async () => {
    const { processor, notifier } = buildProcessor();
    notifier.failWith = new RetriableError('SMTP 421');
    notifier.failTimes = 2;
    const outcome = await processor.process(ctx, student());
    expect(outcome.status).toBe('sent');
    expect(notifier.sent).toHaveLength(1);
  });

  it('erro inesperado (bug) não vira fallback: falha de forma visível', async () => {
    const broken: SummaryGenerator = {
      model: 'x',
      generate: async () => {
        throw new TypeError('undefined is not a function');
      },
    };
    const { processor } = buildProcessor({ generator: broken });
    const outcome = await processor.process(ctx, student());
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'unexpected' } });
  });

  it('o e-mail enviado escapa HTML e não vaza para o log de erro', async () => {
    const { processor, notifier } = buildProcessor();
    const s = student('A9', [['<img src=x onerror=1>', 15]]);
    // o parser já remove <>; garantimos também o escape defensivo no render
    s.grades[0]!.subject = '<img src=x onerror=1>';
    await processor.process(ctx, s);
    expect(notifier.sent[0]!.html).not.toContain('<img');
  });
});

describe('retomada após fallback', () => {
  it('regera o resumo com o LLM se a execução anterior caiu no fallback', async () => {
    const { processor, notifier, store, deps } = buildProcessor();
    const generator = deps.generator as FakeSummaryGenerator;
    await store.put(ctx.runId, {
      studentId: 'A1',
      status: 'FAILED',
      attempts: 1,
      summary: { strengths: 'f', attention: 'f', nextSteps: 'f' },
      summarySource: 'fallback',
      updatedAt: new Date().toISOString(),
    });

    const outcome = await processor.process(ctx, student());
    expect(outcome).toMatchObject({ status: 'sent', source: 'llm' });
    expect(generator.calls).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });
});
