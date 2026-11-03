# Códigos de erro padronizados — bevox-agent-harness

Erros devolvidos em `/complete` (com `error` set) ou em jobs `failed`.

## Categorias

- **`E_VALIDATION_*`** — schema/Zod
- **`E_LLM_*`** — falha de provider LLM
- **`E_TOOL_*`** — falha em tool de mutação
- **`E_PERMISSION_*`** — autonomia/modo violado
- **`E_INFRA_*`** — Redis, Postgres, externos

## Lista

| Código | Descrição | Quem corrige |
|---|---|---|
| E_VALIDATION_PAYLOAD | Payload BullMQ inválido (ADR-006/Zod) | Caller |
| E_VALIDATION_TOOL_ARGS | Tool recebeu args inválidos | Harness LLM (re-prompt) |
| E_LLM_TIMEOUT | LLM não respondeu em N segundos | Retry com backoff |
| E_LLM_RATE_LIMIT | Provider rate-limited | Retry / failover provider (ADR-021) |
| E_LLM_INVALID_OUTPUT | Saída do LLM não conforme schema | Harness LLM (re-prompt) ou bug |
| E_TOOL_NOT_FOUND | LLM chamou tool inexistente | Bug no prompt/registry |
| E_TOOL_BACKEND_5XX | Tool falhou ao chamar backend | Retry / surface to caller |
| E_PERMISSION_MUTATION_IN_DRAFT | Tool de mutação tentou executar em modo draft | Bug — ADR-006 viola |
| E_INFRA_REDIS | Redis indisponível | Ops |
| E_INFRA_POSTGRES | Postgres indisponível | Ops |
| E_INFRA_LLM_ALL_DOWN | OpenAI + Gemini ambos down | Ops; alerta crítico |

Cada erro deve incluir `correlation_id` (= `execution_id`) para tracing.
