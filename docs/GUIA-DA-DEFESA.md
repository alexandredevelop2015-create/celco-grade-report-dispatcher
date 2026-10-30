# Guia da defesa: o que é cada coisa no código

Este guia serve para explicar a solução com segurança: o que cada parte representa, onde está o código que prova cada critério da banca e como demonstrar.

## 1. A história em 30 segundos

> "Ao fechar o período, o sistema lê o CSV de notas, valida e isola dados ruins, gera um resumo personalizado por aluno com um LLM e envia o boletim por e-mail. O ponto central é que o pipeline **sobrevive a falhas**: se o LLM ou o e-mail caírem, nada se perde nem duplica, e dá para reexecutar. No fim sai um relatório com falhas, tokens, custo e tempo por aluno."

Três ideias para repetir sempre:
1. **A unidade de trabalho é um aluno**, e ela é **idempotente** (rodar duas vezes não reenvia nem gasta LLM de novo).
2. **O LLM é opcional para o resultado**: ele melhora o texto, mas se falhar há um fallback. O boletim sempre sai.
3. **Tudo que é externo (LLM, e-mail, armazenamento) fica atrás de uma interface**, então dá para trocar e testar sem rede.

## 2. Como rodar (passo a passo, Windows)

Pré-requisito: Node 20.6 ou superior. Docker só para ver e-mails no Mailpit.

```powershell
cd "C:\Users\Alexandre\Documents\Projetos_pess\Genesis-ITS\celco-grade-report-dispatcher"
npm install
npm test          # 128 testes
chcp 65001        # opcional: acentos corretos no console
npm run demo      # LLM fake, e-mail impresso no terminal, custo zero
```

**Ver os e-mails de verdade (Mailpit):**

```powershell
docker compose up -d
copy .env.example .env      # depois edite o .env: NOTIFIER=smtp
npm run demo
# abra http://localhost:8025
```

**Usar o LLM real:** no `.env`, `LLM_PROVIDER=anthropic` e `ANTHROPIC_API_KEY=...`. Confira os preços em `LLM_PRICE_*`.

**Simular incidentes (ótimos para a demo):**

```powershell
$env:FAKE_LLM_FAILURE_RATE="1"; npm run demo        # LLM 100% fora: todos recebem fallback
$env:FAKE_LLM_FAILURE_RATE="0.3"; $env:LOG_LEVEL="debug"; npm run demo   # falhas intermitentes: retries
Remove-Item Env:FAKE_LLM_FAILURE_RATE               # volta ao normal
node dist/cli.js dispatch --file data/grades.sample.csv --period 2026-1S --validate-only   # só valida
```

**Onde olhar o resultado:** terminal (relatório), `out/2026-1S/report.md` e `report.json`, `out/events.ndjson` (analytics), `out/2026-1S/state.json` (estado por aluno).

## 3. Mapa do código: o que representa o quê

### Conceitos

| Conceito | O que é | Onde |
|---|---|---|
| **Porta** | Interface do que o sistema precisa do mundo externo | `src/domain/ports.ts` |
| **Adaptador** | Implementação concreta de uma porta | `src/llm`, `src/notify`, `src/store`, `src/grades` |
| **Composition root** | Único lugar que decide quais adaptadores usar | `src/app.module.ts` |
| **Erro tipado** | Classifica a falha: vale repetir ou não | `src/domain/errors.ts` |
| **Perfil de notas** | Resumo das notas **sem dados pessoais**, é o que o LLM vê | `src/grades/profile.ts` |
| **Run / período** | Uma execução, identificada pelo `--period` (é a chave da idempotência) | `src/cli.ts`, `dispatcher.service.ts` |

### Pastas

| Pasta | Responsabilidade |
|---|---|
| `src/domain` | Tipos, erros e portas. **Não depende de nada.** |
| `src/grades` | Ler o CSV, validar, sanitizar, montar o perfil |
| `src/llm` | Prompt, gerador real (Anthropic), gerador falso, custo/orçamento, fallback, validação da resposta |
| `src/notify` | Montar o boletim (texto/HTML), enviar por SMTP ou imprimir |
| `src/resilience` | Retry, circuit breaker, rate limiter, concorrência. **Genéricos, sem saber de LLM ou e-mail** |
| `src/store` | Estado por aluno + cache de resumos |
| `src/pipeline` | **O coração:** `StudentProcessor` (um aluno), `DispatcherService` (o lote), `report.ts` |
| `src/observability` | Logs, tracing simulado, analytics |
| `src/config` | Variáveis de ambiente validadas no boot |
| `test/` | Testes |

### Os dois arquivos que você precisa dominar

1. **`src/pipeline/student-processor.ts`**: o que acontece com um aluno. Ordem do método `process`:
   1. consulta o estado: se já está `SENT`, **pula**;
   2. reaproveita o resumo salvo, exceto se foi de fallback;
   3. `obtainSummary`: cache, depois orçamento, depois LLM com `retry(breaker(limiter(chamada)))`, depois fallback se falhar;
   4. grava `GENERATED` (resumo salvo **antes** de enviar);
   5. `send`: mesma proteção do LLM, depois grava `SENT`;
   6. qualquer erro vira `FAILED` com tipo e mensagem, e o resumo fica guardado.
2. **`src/pipeline/dispatcher.service.ts`**: orquestra o lote. Lê o CSV, roda os alunos em paralelo (`runWithConcurrency`), monta e grava o relatório, emite os eventos.

## 4. Critério da banca → onde está → o que dizer

| Critério | Onde | O que dizer |
|---|---|---|
| **Arquitetura** | `domain/ports.ts`, `app.module.ts` | "Hexagonal: o pipeline só conhece interfaces. Troco LLM, canal ou banco mudando uma linha no composition root." |
| **Retry** | `resilience/retry.ts`; classificação em `anthropic-summary-generator.ts` (`classifyLlmError`) e `smtp-notifier.ts` (`classifySmtpError`) | "Backoff exponencial com jitter total, respeita `Retry-After`. Só repete erro transitório (429, 5xx, rede). 400/401 são fatais e erro de programação não repete." |
| **Idempotência** | `student-processor.ts` (início de `process`), `store/json-state-store.ts` | "Chave `(período, aluno)`. `SENT` é pulado. O resumo é gravado antes do envio, então retomar não paga o LLM de novo." |
| **Token management** | `llm/prompt.ts` (`truncateProfile`), `llm/cost.ts`, `LLM_MAX_OUTPUT_TOKENS` | "Prompt curto, truncagem de contexto (teto de disciplinas, as em atenção primeiro), as contas (média, estado) são feitas em código, o LLM só redige. Saída em JSON de 3 campos com limite de tokens." |
| **Prompt engineering** | `llm/prompt.ts`, `llm/parse-summary.ts` | "Papel, idioma, formato JSON, dados em bloco `<dados>` tratados como dados. A saída é validada por schema; se vier errada, conta como falha transitória e tenta de novo." |
| **FinOps** | `llm/cost.ts` (`BudgetGuard`), `grades/profile.ts` (`profileCacheKey`), `LLM_MODEL` | "Quatro alavancas: modelo pequeno, cache por perfil de notas, teto de orçamento por execução (reserva antes de chamar) e fallback sem custo." |
| **Rate limiting / circuit breaker** | `resilience/rate-limiter.ts`, `circuit-breaker.ts` | "O limiter espaça as chamadas. O breaker abre após N falhas seguidas e falha rápido; depois do cooldown testa com uma sonda." |
| **Tratamento de erros** | `domain/errors.ts`, `toErrorInfo` em `student-processor.ts` | "Esperado vs inesperado: fatal e transitório são tratados; bug (`TypeError`) falha alto e não vira fallback silencioso." |
| **Observabilidade** | `observability/*`, `pipeline/report.ts` | "Logs JSON com `runId`, `traceId`, `studentId`. Tracing simulado no formato OpenTelemetry. Métricas no relatório: p50/p95, vazão, taxa de falha." |
| **Product analytics** | `observability/analytics.ts`, eventos em `dispatcher.service.ts` | "`run_started`, `student_processed`, `student_failed`, `run_completed`, em `events.ndjson`, prontos para um warehouse." |
| **Segurança** | `grades/sanitize.ts`, `observability/logger.ts`, `config/config.ts` | "O LLM nunca vê nome ou e-mail. Entrada sanitizada, HTML escapado, logs com redaction, chave só por ambiente, e-mail mascarado." |
| **Escalabilidade** | `student-processor.ts` + `docs/SCALING.md` | "O processador é stateless: todo estado está atrás de portas. Para escalar, é fila + N workers + Postgres/Redis. O pipeline não muda." |
| **Testes** | `test/` | "128 testes: regras do CSV, retry com relógio falso, breaker, orçamento, idempotência, retomada, fallback, integração do lote e contrato do gerador." |

## 5. Roteiro de demonstração (10 min)

1. **Feliz (2 min):** `npm run demo`. Mostre o relatório: enviados, custo, cache, p95. Aponte as **linhas rejeitadas** e **alunos em quarentena**.
   *Fale:* "o CSV de exemplo tem de propósito e-mail inválido, nota fora da escala, campo vazio, duplicata, nota contraditória e uma tentativa de prompt injection."
2. **Mailpit (1 min):** mostre os boletins em `localhost:8025` (se o Docker estiver rodando).
3. **Idempotência (1 min):** rode `node dist/cli.js dispatch --file data/grades.sample.csv --period 2026-1S` **sem** `--fresh`. Resultado: `já enviados antes: 6`, nada reenviado.
4. **Incidente do LLM (3 min):** `$env:FAKE_LLM_FAILURE_RATE="1"; npm run demo`. Todos recebem fallback, relatório mostra `fallback: N` e o motivo (`circuit_open`, `retriable_exhausted`). *Fale:* "ninguém fica sem boletim, e o relatório denuncia a degradação."
5. **Código (3 min):** abra `student-processor.ts` e percorra o `process`, depois `retry.ts` (são 25 linhas).

## 6. Perguntas difíceis e respostas honestas

As respostas completas estão em [DEBRIEFING.md](DEBRIEFING.md). As que mais derrubam candidato:

- **"Isso é exatamente-uma-vez?"** Não, e dizer isso é o certo. É *pelo menos uma vez com idempotência*. A janela entre enviar e gravar `SENT` é coberta pelo `Message-ID` estável; o fechamento total exige outbox transacional (descrito, não implementado).
- **"Por que não usou fila?"** Para provar o desenho sem exigir Redis na avaliação. O `StudentProcessor` é o handler de um job e já é stateless; está desenhado em `SCALING.md`.
- **"O estado é um JSON, isso escala?"** Não, é de processo único, e está atrás de `RunStore`. Trocar por Postgres é um adaptador.
- **"O fallback não esconde falha?"** Esconde do aluno, não da operação: o relatório conta e classifica cada fallback, e o evento de analytics carrega a origem. Em produção eu alertaria por taxa de fallback.
- **"Os custos são reais?"** São estimativas: os preços são configuração (`LLM_PRICE_*`) e devem ser conferidos.
- **"O e-mail foi testado de verdade?"** Os adaptadores (Resend e SMTP) têm testes de classificação de erro e idempotência com cliente simulado. O envio real exige credenciais (Resend) ou Docker (Mailpit): mostre na demo, não prometa o que não rodou.
- **"Por que o LLM não recebe o nome?"** Minimização de dados pessoais: o texto não precisa do nome (a saudação é montada por nós), e isso também deixa o cache seguro.

## 7. Glossário

- **Idempotência:** executar a mesma operação várias vezes produz o mesmo efeito que uma vez.
- **Backoff exponencial:** esperar 0,5s, 1s, 2s, 4s... entre tentativas.
- **Jitter:** sorteio no tempo de espera para que muitos jobs não tentem todos no mesmo instante.
- **Circuit breaker (disjuntor):** depois de várias falhas, para de chamar a dependência por um tempo (falha rápido), e testa uma chamada antes de reabrir.
- **Rate limiting:** limitar chamadas por segundo para respeitar o limite do provedor.
- **Fallback:** alternativa degradada, mas funcional, quando o caminho principal falha.
- **Prompt injection:** texto malicioso dentro dos dados tentando mudar as instruções do LLM.
- **Porta/adaptador:** interface do que o sistema precisa / implementação concreta dela.
- **Quarentena:** aluno com dado ambíguo que não recebe boletim até alguém resolver.
- **Outbox:** gravar a intenção de enviar na mesma transação do estado, para que um processo separado entregue com segurança.
