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

## 7. Lançar aluno novo ou alterar nota (reenvio automático)

O estado guarda uma **impressão digital** (hash) das notas, do nome e do e-mail de cada aluno. A cada execução do **mesmo período**:

| Situação no CSV | O que acontece |
|---|---|
| Aluno novo | Recebe o boletim normal |
| Nota alterada, ou disciplina acrescentada | Recebe um boletim **"(atualizado)"** com resumo novo e o aviso "houve uma alteração nas tuas notas" |
| Sem mudança | Ignorado (custo zero) |

```powershell
# 1. edite o CSV: acrescente as linhas do aluno novo ou corrija a nota
# 2. rode o MESMO comando e o MESMO --period (sem --fresh)
node dist/cli.js dispatch --file data/grades.sample.csv --period 2026-1S
```

Para forçar o reenvio de alguém **sem** mudança nas notas: `--resend A1001` (vários: `--resend A1001,A1002`). Reaproveita o resumo salvo, então custa zero de LLM.

O relatório mostra `Enviados: N (M atualizados)`. O `Message-ID` do e-mail inclui o hash, então o reenvio não é confundido com duplicata.

**CSV do Excel:** arquivos com `;` e BOM são detectados automaticamente pelo cabeçalho.

**Limite conhecido:** execuções antigas (anteriores a este recurso) não têm hash e são tratadas como "sem mudança". Para elas, use `--fresh` ou `--resend`.

## 8. Planilha de alterações (`alteracoes.csv`)

Cada lançamento fica registrado em `out/<período>/alteracoes.csv` (só cresce; nunca é sobrescrito). Abre direto no Excel em português (separador `;`, UTF-8 com BOM, decimais com vírgula).

| Coluna | Conteúdo |
|---|---|
| `data_hora` | Momento do lançamento (UTC) |
| `aluno_id`, `aluno` | Identificação |
| `tipo` | `novo`, `atualizado` (nota ou disciplina mudou) ou `reenvio` (`--resend` sem mudança) |
| `disciplina`, `nota_anterior`, `nota_nova` | O que mudou. Disciplina nova: `nota_anterior` vazia |
| `resultado` | `enviado` ou `falha: <motivo>` |

Exemplo, depois de corrigir a Matemática da Ana de 12 para 15:

```
"2026-10-29 17:35:58";"A1001";"Ana Ribeiro";"atualizado";"Matemática";"12";"15";"enviado"
```

O e-mail da aluna mostra o mesmo antes/depois (`Matemática: 12 → 15/20`). O estado (`state.json`) guarda só o valor atual; **o histórico está na planilha**. Se o envio falhar, a linha sai com `falha: ...`, e a nova tentativa compara com o último boletim **entregue**, não com o que falhou.

A planilha contém nome do aluno: é um arquivo local de auditoria, não vai para o Git (`out/` está no `.gitignore`).

## 9. Excluir o lançamento de um aluno

Apague **todas as linhas** do aluno no CSV e rode o mesmo comando (mesmo `--period`, sem `--fresh`):

```powershell
node dist/cli.js dispatch --file data/grades.csv --period 2026-1S
```

O aluno recebe **"Boletim 2026-1S (lançamento removido)"**, com a lista das notas anuladas. O relatório mostra `Enviados: 1 (0 atualizados, 1 removidos)` e a planilha ganha linhas `removido` com a nota anterior. O aviso sai **uma única vez**: o registro vira `REMOVED`. Se o aluno voltar ao CSV depois, é tratado como **novo**.

Remover **só uma disciplina** (o aluno continua no arquivo) não é "removido": ele recebe o boletim **atualizado** com `Matemática: removida (era 7/20)`.

### Trava de segurança

Apagar muita coisa de uma vez costuma ser arquivo errado (CSV truncado, vazio ou de outro período). Por isso o aviso **não é enviado** quando:
- o CSV não tem nenhum aluno; ou
- somem mais de `max(3, metade dos alunos já enviados)`.

Nesse caso o relatório mostra "Atenção: remoções bloqueadas", o código de saída é `1` e nada é enviado. Se for intencional:

```powershell
node dist/cli.js dispatch --file data/grades.csv --period 2026-1S --confirm-removals
```

Aluno com **linha rejeitada** (e-mail inválido etc.) ou em **quarentena** continua no arquivo e **não** é tratado como removido.

**Limite conhecido:** registros criados antes deste recurso não guardam o e-mail do aluno. Se um deles for removido, o sistema avisa no log que não conseguiu notificar. Use `npm run demo` (ou `--fresh`) para recriar o estado.

## 10. Envio real pelo Resend

O Resend é um canal de e-mail por API (alternativa ao Mailpit local). Configure no `.env`:

```
NOTIFIER=resend
RESEND_API_KEY=<sua chave, só de envio>
MAIL_FROM="Secretaria Académica <onboarding@resend.dev>"
```

A chave **nunca vai para o Git** (`.env` está no `.gitignore`). Crie uma chave com permissão **"Sending access"**: se vazar, só consegue enviar, não lista domínios nem apaga nada.

| Proteção | Como funciona |
|---|---|
| Idempotência | Cada envio leva o cabeçalho `Idempotency-Key` (`período:aluno:hash`). O Resend ignora repetições por 24 h, então um retry nunca vira e-mail duplicado |
| Limite de taxa | Plano gratuito: 2 requisições/s. O limitador usa `RESEND_REQUESTS_PER_SEC=2`; um `429` é repetido respeitando `Retry-After` |
| Erros | `429`/`5xx`/rede → retry com backoff e circuit breaker. `401`/`403`/`422` (chave inválida, domínio não verificado, e-mail inválido) → fatal, sem retry, com a mensagem do Resend |
| Segredo | A chave só vai no cabeçalho `Authorization`; nunca aparece em log, erro ou relatório (há teste para isso) |

### Limites da conta gratuita (importante para a demonstração)

- Sem domínio verificado, o remetente só pode ser `onboarding@resend.dev` e **só entrega no e-mail do dono da conta**. Para enviar aos alunos de verdade é preciso verificar um domínio em https://resend.com/domains e usar um `MAIL_FROM` desse domínio. Com um domínio não verificado, o resultado é `403 validation_error`, como mostra o cenário abaixo.
- Para testar sem enviar a ninguém, use os endereços de simulação do Resend: `delivered@resend.dev` (aceita), `bounced@resend.dev` (devolve) e variantes com `+etiqueta`, como `delivered+ana@resend.dev`.

```powershell
$env:NOTIFIER="resend"; $env:MAIL_FROM="Secretaria <onboarding@resend.dev>"
node dist/cli.js dispatch --file data/grades.csv --period 2026-1S --fresh
```

Validado: 4 envios aceitos pela API para `delivered+...@resend.dev`, reexecução sem reenviar, e remetente de domínio não verificado falhando como `fatal` com a mensagem do Resend.
