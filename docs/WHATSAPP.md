# WhatsApp via n8n + Evolution GO

Além do e-mail, o boletim (e as correções e remoções) pode ir por WhatsApp. O app **não fala com o Evolution GO**: chama um webhook do n8n, que envia a mensagem. Assim a conexão com o WhatsApp, a formatação final e a troca de provedor ficam fora do código.

```
StudentProcessor ──► MultiChannelNotifier ──► ResendNotifier ──► e-mail (canal oficial)
                           │  (só se o e-mail saiu e o aluno tem telefone)
                           └─► WhatsappWebhookNotifier ──POST──► n8n ──► Evolution GO ──► WhatsApp
```

## Regras de comportamento

| Situação | O que acontece |
|---|---|
| Aluno sem telefone | Só e-mail. |
| E-mail falhou | Falha normal do pipeline (retry, disjuntor, estado `FAILED`). O WhatsApp **não** é tentado. |
| E-mail saiu, WhatsApp falhou | Retry com backoff próprio; esgotado, vira `warn` (`event: whatsapp_failed`, telefone mascarado). O e-mail **não** é reenviado e o aluno continua `SENT`. |
| Webhook responde 429/5xx/timeout | Retriável. |
| Webhook responde 400/401/403/404 | Fatal (segredo errado, payload inválido): sem retry. |
| Retry ou retomada do mesmo envio | O n8n deduplica pela `idempotencyKey`: nunca duas mensagens iguais. |
| Auditoria à secretaria (`ADMIN_EMAIL`) | Só e-mail. |

O WhatsApp é **melhor esforço**: não há estado por canal. Quem precisar de garantia de entrega no WhatsApp deve evoluir para um outbox por canal (ver `docs/SCALING.md`).

## Configuração

### 1. No app (`.env`)

```
N8N_WEBHOOK_URL=https://SEU-N8N/webhook/boletim-whatsapp
N8N_WEBHOOK_SECRET=<segredo longo e aleatório>
WHATSAPP_REQUESTS_PER_SEC=1
```

Sem `N8N_WEBHOOK_URL` o canal fica desligado. Use a URL **de produção** (`/webhook/`), não a de teste (`/webhook-test/`).

### 2. No n8n

1. Importe `n8n/boletim-whatsapp.json` (Workflows → Import from file).
2. Defina as variáveis de ambiente do contêiner do n8n:
   ```
   N8N_WEBHOOK_SECRET=<o mesmo segredo>
   EVOLUTION_API_URL=https://SEU-EVOLUTION        # sem barra no final
   EVOLUTION_API_KEY=<chave/token da instância>
   ```
   O workflow lê com `$env`: não pode haver `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`.
3. **Ative** o workflow (a deduplicação usa `staticData`, que só persiste em execuções de produção).
4. Confira no Swagger do **seu** Evolution GO o endpoint de envio de texto. O workflow assume `POST {EVOLUTION_API_URL}/send/text` com header `apikey` e corpo `{ "number": "5511999990000", "text": "..." }`; se a sua versão usar outro caminho ou outro formato, é só ajustar o nó "Evolution GO - enviar texto".

### 3. Telefone do aluno

Coluna opcional `phone` no CSV (ou o campo "WhatsApp" na tela), com DDI + DDD + número, só dígitos (`5511999990000`). Aceita `+55 (11) 99999-0000` e normaliza. Telefone inválido rejeita a linha (`INVALID_FIELD`, campo `phone`). Mudar só o telefone **não** reenvia o boletim.

## Testando sem alunos reais

```bash
curl -X POST "$N8N_WEBHOOK_URL" \
  -H "content-type: application/json" -H "x-webhook-secret: $N8N_WEBHOOK_SECRET" \
  -d '{"idempotencyKey":"teste:1","phone":"55SEUNUMERO","name":"Teste","text":"Olá! Teste do boletim."}'
# {"status":"sent"}   (repetindo a mesma chave: {"status":"duplicate"})
```

Depois cadastre um aluno pela interface com o **seu** número e confira e-mail e WhatsApp.

## Cuidados

- WhatsApp bloqueia números que enviam muitas mensagens rápido ou para quem não conhece o remetente. Mantenha a taxa baixa (`WHATSAPP_REQUESTS_PER_SEC`) e avise os alunos de que receberão o contato.
- O texto vai direto do app (`whatsappText`): curto, com média e o que mudou. O boletim completo continua no e-mail.
- Nunca ponha o segredo ou a chave do Evolution no repositório.
