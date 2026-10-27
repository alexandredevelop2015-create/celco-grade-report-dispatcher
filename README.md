# Grade Report Dispatcher

Ao fechar o período letivo, lê o arquivo de notas, gera um **resumo personalizado por aluno com um LLM** e envia o **boletim por e-mail**, terminando com um **relatório de execução** (total, falhas, tokens, custo estimado e tempo por aluno).

Solução para a **Opção 2** do *Desafio Técnico Software Engineer – Backoffice & Automation*. TypeScript + NestJS (contexto de aplicação, sem HTTP).

```
CSV ──► validar/sanitizar ──► [por aluno, em paralelo] ──► relatório
                               perfil → cache? → LLM (retry + breaker + limiter + orçamento)
                                              └─ falhou? → resumo determinístico (fallback)
                               persistir resumo → e-mail (retry + breaker + limiter) → SENT
```

## Como rodar

Requisitos: Node ≥ 20.6 (testado no 24). Docker é opcional (só para o Mailpit).

```bash
npm install
npm test                 # 58 testes unitários, de integração e de contrato
npm run demo             # roda o CSV de exemplo: LLM fake, e-mail impresso no console, custo zero
```

Saída: logs JSON no stdout, relatório em Markdown no stderr e arquivos em `out/<período>/`:

| Arquivo | Conteúdo |
|---|---|
| `report.json` / `report.md` | Relatório de execução |
| `state.json` | Estado por aluno + cache de resumos (base da idempotência/retomada) |
| `../events.ndjson` | Eventos de analytics (`run_started`, `student_processed`, `student_failed`, `run_completed`) |

### E-mail de verdade (Mailpit local)

```bash
docker compose up -d                     # SMTP em :1025, caixa de entrada em http://localhost:8025
cp .env.example .env                     # e defina NOTIFIER=smtp
npm run demo
```

### LLM de verdade (Anthropic)

```bash
# no .env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-haiku-5-5
```

A chave só é lida do ambiente (`.env` está no `.gitignore`). Os preços (`LLM_PRICE_*_PER_MTOK`) são configuráveis e **devem ser conferidos** contra a tabela vigente do provedor: o custo do relatório é uma estimativa.

### Comandos úteis

```bash
node dist/cli.js dispatch --file data/grades.sample.csv --period 2026-1S --validate-only   # só valida o CSV
node dist/cli.js dispatch --file <csv> --period 2026-1S --concurrency 10

# Simular incidente: 100% das chamadas ao LLM falham → todos recebem o fallback, nenhum fica sem boletim
LLM_PROVIDER=fake FAKE_LLM_FAILURE_RATE=1 npm run demo
# Simular 30% de falhas intermitentes → retries com backoff, algumas cache/fallback
FAKE_LLM_FAILURE_RATE=0.3 LOG_LEVEL=debug npm run demo
```

**Reexecutar o mesmo `--period` retoma de onde parou**: quem já está `SENT` é pulado, quem falhou no envio reaproveita o resumo salvo (sem pagar LLM de novo). Para recomeçar do zero, apague `out/<período>`.
Código de saída: `0` ok · `1` houve alunos com falha · `2` erro de uso/entrada.

### Formato do CSV

`student_id,name,email,subject,grade` — uma linha por aluno/disciplina, escala 0–20 (configurável), vírgula ou ponto decimal. Veja `data/grades.sample.csv`, que inclui de propósito: e-mail inválido, nota fora da escala, campo ausente, duplicata idêntica, nota contraditória, e-mail divergente e uma tentativa de *prompt injection* no nome da disciplina.

## O que ele faz com cada caso de borda

| Entrada | Comportamento |
|---|---|
| Campo ausente / e-mail inválido / nota fora da escala | Linha rejeitada e listada no relatório (linha + motivo, **sem PII**) |
| Duplicata idêntica | Ignorada e contada |
| Mesma disciplina com notas diferentes, ou e-mails diferentes para o mesmo aluno | **Aluno em quarentena**: nenhum boletim sai até a secretaria resolver (enviar nota errada é pior que atrasar) |
| LLM com 429/5xx/timeout | Retry com backoff exponencial + jitter, respeitando `Retry-After` |
| LLM com 400/401/403 | Fatal, sem retry (repetir só gasta dinheiro) → fallback |
| LLM fora do ar de vez | Disjuntor abre, falha rápido; aluno recebe resumo determinístico |
| Orçamento da execução estourado | Restante usa fallback; custo nunca passa do teto |
| Saída do LLM fora do contrato JSON | Tratada como transitória (retry) |
| SMTP 4xx / rede | Retry + disjuntor; 5xx / endereço inválido → fatal, estado `FAILED`, resumo preservado |
| Processo morre no meio | Reexecução retoma pelo estado persistido |

## Estrutura

```
src/
  domain/        tipos, erros (Retriable/Fatal/CircuitOpen) e PORTAS (interfaces)
  grades/        leitura/validação do CSV, sanitização, perfil de notas
  llm/           prompt, gerador Anthropic, gerador fake, custo/orçamento, fallback
  notify/        e-mail (SMTP), console, template do boletim
  resilience/    retry, circuit breaker, rate limiter, pool de concorrência
  store/         estado por aluno + cache (JSON atômico)
  pipeline/      StudentProcessor (1 aluno, idempotente), DispatcherService (lote), relatório
  observability/ logs estruturados (pino + redaction), tracer simulado, analytics
  app.module.ts  composition root (injeção por token/porta)
test/            unitários, integração do pipeline e contrato
docs/            arquitetura, decisões, escala e roteiro do debriefing
```

## Documentação

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diagramas (Mermaid), contratos e máquina de estados
- [docs/DECISIONS.md](docs/DECISIONS.md): decisões tomadas e **o que ficou de fora e por quê**
- [docs/SCALING.md](docs/SCALING.md): como chegar a 10k alunos/hora, exatamente-uma-vez, LLM 10× mais caro
- [docs/DEBRIEFING.md](docs/DEBRIEFING.md): respostas preparadas para as perguntas do debriefing e cenário de incidente

## Licença

MIT
