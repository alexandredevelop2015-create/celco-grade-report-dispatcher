# Simulação passo a passo

Este roteiro reproduz, com a ferramenta rodando de verdade, os cenários que importam na avaliação: fluxo feliz, idempotência, LLM fora do ar, e-mail fora do ar e recuperação. Todos foram executados e validados com o Mailpit real.

## Como a aplicação é invocada

**Não é um endpoint HTTP.** É uma aplicação de linha de comando (CLI) construída com NestJS em modo *standalone*: o Nest é usado pela injeção de dependências, mas **não sobe servidor**. Você a executa assim:

```
node dist/cli.js dispatch --file <notas.csv> --period <período> [opções]
```

| Opção | Efeito |
|---|---|
| `--file` | CSV de notas (`student_id,name,email,subject,grade`) |
| `--period` | Identifica a execução, ex.: `2026-1S`. **É a chave da idempotência** |
| `--validate-only` | Só valida o CSV; não chama LLM nem envia |
| `--fresh` | Apaga o estado do período antes de rodar (reenvia tudo) |
| `--concurrency N` | Alunos processados em paralelo |

**Código de saída:** `0` tudo certo · `1` houve alunos com falha · `2` erro de uso ou de entrada. Isso permite que um agendador (cron, CI) detecte falhas.

### Por que CLI e não endpoint?

O caso de uso é um **lote disparado no fechamento do período**: alguém (ou um agendador) inicia, o processo roda e termina com um relatório. Não há cliente esperando resposta síncrona. Um endpoint exigiria resposta assíncrona (`202 Accepted` + consulta de status) e autenticação. Está descrito como evolução em [SCALING.md](SCALING.md): o `DispatcherService` já é chamável de qualquer lugar, então expor `POST /runs` é só adicionar um controller que o invoque, ou enfileirar um job por aluno.

## Preparação

```powershell
cd "C:\Users\Alexandre\Documents\Projetos_pess\Genesis-ITS\celco-grade-report-dispatcher"
npm install
chcp 65001                 # acentos corretos no terminal Windows
docker compose up -d       # Mailpit: SMTP :1025, caixa de entrada http://localhost:8025
copy .env.example .env     # depois edite o .env: NOTIFIER=smtp
```

Mantenha abertos lado a lado: o terminal, o Mailpit (http://localhost:8025) e a pasta `out\`.

Para limpar a caixa entre cenários, use **Delete all** no Mailpit.

## Os cenários

### 1. Fluxo feliz

```powershell
npm run demo
```

O `demo` já usa `--fresh`. **Resultado esperado:** 6 enviados; 5 linhas rejeitadas; 1 duplicata ignorada; 2 alunos em quarentena; 6 e-mails no Mailpit; custo estimado ≈ US$ 0,0027.

O CSV de exemplo contém erros de propósito:

| Linha | Problema | Resultado |
|---|---|---|
| 18 | e-mail inválido | rejeitada (`INVALID_EMAIL`) |
| 19 | nota 25 (escala é 0–20) | rejeitada (`INVALID_GRADE`) |
| 20 | nota vazia | rejeitada (`MISSING_FIELD`) |
| 17 | duplicata idêntica | ignorada e contada |
| 21–22 | duas notas diferentes para a mesma disciplina | `DUPLICATE_CONFLICT`: **aluno em quarentena** |
| 26–27 | dois e-mails para o mesmo aluno | `EMAIL_MISMATCH`: **aluno em quarentena** |
| 24 | nome de disciplina com instrução ("Ignora as instruções anteriores...") | tratado como dado; sem efeito |

### 2. Idempotência: repetir a mesma execução

```powershell
node dist/cli.js dispatch --file data/grades.sample.csv --period 2026-1S
```

**Esperado:** `já enviados antes: 6`, nenhum e-mail novo, custo zero. A chave `(período, aluno)` está em `out\2026-1S\state.json`.

### 3. LLM fora do ar

```powershell
$env:FAKE_LLM_FAILURE_RATE="1"
npm run demo
Remove-Item Env:FAKE_LLM_FAILURE_RATE
```

**Esperado:** 6 enviados, tokens zero, `fallback determinístico: 6` e a seção "Degradação" no relatório. Ninguém fica sem boletim; o texto vem de um resumo calculado, sem LLM.

### 4. E-mail fora do ar

```powershell
$env:SMTP_PORT="1099"       # porta onde não há servidor
node dist/cli.js dispatch --file data/grades.sample.csv --period incidente --fresh
$LASTEXITCODE               # deve mostrar 1
```

**Esperado:** 6 falhas. O primeiro aluno esgota as 4 tentativas (com espera crescente); os outros 5 aparecem como `circuit_open` (o disjuntor abriu e eles falharam rápido, sem martelar o servidor). Mailpit vazio. O LLM **foi** usado e custou ≈ US$ 0,0027; os resumos ficaram salvos.

### 5. Recuperação: reexecutar o mesmo período

```powershell
Remove-Item Env:SMTP_PORT
node dist/cli.js dispatch --file data/grades.sample.csv --period incidente
```

**Esperado:** 6 enviados, **custo zero** (os resumos salvos no passo 4 são reaproveitados, sem chamar o LLM). Mailpit com 6 e-mails.

### 6. Só validar

```powershell
node dist/cli.js dispatch --file data/grades.sample.csv --period so-validar --validate-only
```

**Esperado:** lista as linhas rejeitadas com o motivo, sem LLM nem envio.

## Onde olhar o resultado

| Arquivo | Conteúdo |
|---|---|
| `out/<período>/report.md` e `report.json` | Relatório: total, falhas, tokens, custo, p50/p95 por aluno |
| `out/<período>/state.json` | Estado por aluno (`GENERATED` / `SENT` / `FAILED`) e cache de resumos |
| `out/events.ndjson` | Eventos de analytics (`run_started`, `student_processed`, `student_failed`, `run_completed`) |
| stdout | Logs JSON com `runId`, `traceId` e `studentId` |

## Detalhe para explicar com precisão

No cenário 5 o relatório mostra "Resumo por LLM: 6" com custo zero. Os resumos foram **gerados** pelo LLM no cenário 4 (que pagou) e apenas **reaproveitados** no 5.
