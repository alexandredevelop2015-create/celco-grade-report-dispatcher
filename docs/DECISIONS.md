# Decisões e trade-offs

## Decisões tomadas

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 1 | **Cálculos em código, LLM só redige** (média, estado por disciplina) | Menos tokens, resultado verificável, sem alucinação de nota | Mandar a tabela bruta e pedir análise |
| 2 | **Fallback determinístico** em vez de falhar | O aluno precisa do boletim; o texto do LLM é complemento. O relatório registra quem recebeu fallback e por quê | Falhar o aluno (pior para o usuário) |
| 3 | **Quarentena** para notas contraditórias / e-mail divergente | Enviar uma nota errada é um incidente; atrasar é um ticket | "Última linha vale" |
| 4 | **Resumo salvo antes do envio** | Retentar envio não gasta LLM; permite retomada | Gerar e enviar no mesmo passo |
| 5 | **Erro tipado `Retriable` vs `Fatal`** traduzido no adaptador | Retry/breaker ficam genéricos e testáveis; evita repetir 401/400 | `try/catch` com `instanceof` do SDK espalhado |
| 6 | **`maxRetries: 0` no SDK** | A política de retry é nossa (jitter, breaker, métricas, `Retry-After`) | Retry embutido do SDK + o nosso (retry multiplicativo) |
| 7 | **Cache por hash de perfil (notas arredondadas)** | Perfis parecidos geram o mesmo texto: corta chamadas. Sem PII, seguro para persistir | Cache por aluno (acerto ≈ 0) |
| 8 | **Modelo pequeno por padrão** (`claude-haiku-5-5`) | Tarefa simples e estruturada; é o maior alavanca de custo | Modelo grande para tudo |
| 9 | **Orçamento por execução com reserva prévia** | Teto duro mesmo com workers concorrentes | Só medir o custo depois |
| 10 | **Estado em JSON local atrás de portas** | Zero infraestrutura para rodar e avaliar; a troca por Postgres/Redis é só um adaptador | Subir Postgres/Redis só para a demo |
| 11 | **LLM e SMTP *fake*/console por padrão** | Demo e CI sem chave nem custo; permite injetar falhas | Exigir credenciais para rodar |
| 12 | **Português de Portugal** nos textos ao aluno, escala 0–20, aprovado ≥ 10 | Contexto da instituição (Lisboa) | Escala 0–10 genérica |
| 13 | **Truncagem de contexto** (`truncateProfile`, teto de 20 disciplinas, as em atenção primeiro, `omitted` informado ao LLM) | Limita o custo de entrada por aluno sem perder o que importa; a média usa todas as disciplinas | Mandar tudo sempre |

## O que **não** implementei (e por quê)

| Item | Por que ficou de fora | Como seria |
|---|---|---|
| **Fila distribuída (BullMQ/SQS) e workers separados** | Fora do escopo das 2 h e exigiria Redis para avaliar; o pool em memória prova o desenho. A porta de execução já isola isso | Ver `docs/SCALING.md`: um job por aluno, `jobId = run:aluno`, N workers |
| **Exatamente-uma-vez de verdade** | Impossível entre sistemas distintos sem cooperação do destino. Entrego *at-least-once* + idempotência + `Message-ID` estável | Outbox transacional + `claim` atômico no banco; ver SCALING |
| **Claim atômico entre processos** | O estado é um arquivo; só há um processo | `UPDATE ... WHERE status IN (...) RETURNING` ou `SET NX` com TTL |
| **Rate limit compartilhado entre instâncias** | O limiter é por processo | Token bucket no Redis |
| **OpenTelemetry real / métricas Prometheus** | Tracing está simulado em logs; interface compatível | `@opentelemetry/api` + exporter OTLP; contadores/histogramas |
| **Batch API do provedor / prompt caching** | O prompt é curto (abaixo do mínimo cacheável) e o envio é por aluno; batch API é assíncrona e mais barata, boa para volume | Batch API com desconto para jobs não urgentes |
| **Contabilizar tokens de tentativas que falharam no parse** | Subestima levemente o custo quando a saída vem malformada | Retornar `usage` também no erro |
| **Template i18n / anexo PDF do boletim** | Fora do foco do desafio | Renderizar PDF e anexar |
| **Teste de integração contra SMTP/LLM reais** | Sem credenciais no CI; Resend e SMTP têm teste de classificação de erro e idempotência com cliente simulado; o envio real depende de credenciais | Mailpit no CI + teste de contrato gravado |
| **Autenticação na UI** | A interface web (extra, não pedida) é ferramenta local: escuta só em 127.0.0.1, valida Host/Origin e usa CSP estrita | Proxy com autenticação na frente, ou SSO |

## Riscos conhecidos

- **Janela entre `send` e `put(SENT)`**: se o processo morrer ali, a retomada reenvia. Mitigado pelo `Message-ID` estável; só o outbox elimina de vez.
- **Fallback pode esconder um LLM degradado** em silêncio. Por isso o relatório conta `fallbackUsed`, discrimina o motivo e o analytics emite `source`. Em produção: alerta se `fallbackUsed / total` passar de um limiar.
- **O nome de disciplina com instrução maliciosa** aparece no e-mail do próprio aluno (é o dado dele). A defesa é impedir que a instrução *execute* (delimitação + validação de saída + sem ferramentas), não escondê-lo.
- **Preços do LLM** são configuração: o custo reportado é uma estimativa.
