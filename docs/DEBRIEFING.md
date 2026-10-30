# Roteiro do debriefing

## Walkthrough (15 min)

1. **Problema e escolha (1 min):** Opção 2 porque cobre mais critérios com menos infraestrutura (fila, custo e retry são o centro do problema).
2. **Diagrama** (`docs/ARCHITECTURE.md`): portas e adaptadores; `StudentProcessor` é a unidade idempotente.
3. **Demo (3 min):** `npm run demo` → mostrar o relatório; `FAKE_LLM_FAILURE_RATE=1 npm run demo` → todos recebem fallback; rodar de novo → retoma e pula `SENT`.
4. **Código-chave (6 min):** `withRetry` + `CircuitBreaker` + classificação de erro em `anthropic-summary-generator.ts`; `student-processor.ts` (ordem: cache → orçamento → LLM → persistir → enviar).
5. **Testes (2 min):** `student-processor.spec.ts` lê como especificação do comportamento sob falha.
6. **O que ficou de fora (2 min):** `docs/DECISIONS.md`.

## Perguntas previstas

**Como escalaria para 10k usuários/hora?**
É ~2,8/s: um processo com concorrência 10 já chega perto. Para robustez e picos: fila com um job por aluno, workers stateless com autoscaling, estado no Postgres, rate limit/breaker compartilhados no Redis e backpressure. O pipeline já é stateless atrás de portas; muda o composition root. Detalhes: `docs/SCALING.md`.

**E se o LLM custasse 10× mais?**
Primeiro não chamar (cache por faixa, templates para perfis comuns), depois modelo menor para o caso comum e Batch API assíncrona, e prompt/saída mais curtos. O teto por execução já existe e degrada para fallback. Decido com o relatório de custo por aluno.

**Como garantir exatamente-uma-vez?**
Não existe ponta a ponta entre sistemas distintos; entrego *at-least-once + idempotência*: chave `(run, aluno)`, estado `SENT` pulado, resumo salvo antes do envio, `Message-ID` estável. A janela `send → persistir` se fecha com outbox transacional e claim atômico com lease entre workers.

**Uma API está fora do ar, o que acontece?**
Ver tabela em `docs/SCALING.md`. LLM fora → retry → breaker abre → fallback, ninguém fica sem boletim. SMTP fora → `FAILED` com resumo preservado → reexecução só reenvia. Nada é perdido e nada duplica.

**Por que erro retriável vs. fatal?**
Repetir 401/400 só gasta dinheiro e mascara config errada; não repetir 429/503 perde envios que dariam certo. Cada adaptador traduz o erro externo para uma das duas classes e o resto do sistema é genérico.

**Como protegeu contra prompt injection?**
O nome da disciplina é o vetor. Defesas em camadas: sanitização e limite de tamanho, dados em bloco `<dados>` declarado como dados, saída validada por schema (só 3 strings), o modelo não tem ferramentas, e o LLM nunca vê PII. Está no CSV de exemplo.

**O que você faria com mais tempo?**
Fila + Postgres + Redis (SCALING), OpenTelemetry real, métricas Prometheus, outbox, teste de contrato gravado contra o provedor, alerta por taxa de fallback.

## Pontos fracos (assumir em vez de esconder)

- O envio de e-mail (Resend/SMTP) é validado por testes com cliente simulado e pelo cenário de falha; o envio real depende de credenciais e deve ser conferido antes da demo (Resend, ou Mailpit com Docker).
- O custo é estimativa; preços são configuração.
- O estado em JSON é de processo único.
