# Payload BullMQ — schema canônico

Conforme ADR-006 + ADR-001 + ADR-003.

```jsonc
{
  // Identificação
  "execution_id": "01HXYZ...",                  // UUIDv7
  "execution_token": "hex64-...",                // assinatura
  "workspace_id": "01HXYZ...",                   // UUIDv7 — ADR-001/003
  "tenant_id": null,                              // alias legado; preferir workspace_id

  // Configuração
  "execution_mode": "manual_assisted | copilot | autonomous_supervised",  // ADR-006 obrigatório

  // Contexto
  "conversation_id": "01HXYZ...",
  "channel_id": "01HXYZ...",
  "customer_id": "01HXYZ...",                    // ADR-005: read-through ao backend

  // Mensagem-gatilho
  "trigger_message": {
    "id": "msg-...",
    "content": "...",
    "received_at": "2026-05-14T15:00:00Z"
  },

  // Modelagem
  "model_overrides": {
    "provider": "openai | gemini",                // ADR-021
    "model_id": "...",
    "max_rounds": 8
  },

  // Idempotência
  "idempotency_key": "evt-msg-receive-{message_id}",  // ADR-023: derivado de evento

  // Bounding de execução (J8/J9) — opcional
  "max_cost_usd": 0.50                            // J9: teto de custo por-execução (USD)
}
```

## Campos opcionais

- `max_cost_usd: z.number().positive().max(1000).optional()` (J9 / runtime-gap
  J8-J9): teto de custo por-execução em USD. Quando ausente, cai no default
  `HARNESS_MAX_COST_USD` do env (0 = sem teto). Quando o custo acumulado
  (centavos, via `calculateCostCents` no `onUsage`) cruza o teto, o surface
  loop aborta com `ExecutionAbortError("cost_ceiling")` → `/complete` com
  `strategy:"aborted_cost"`. Opcional → minor change (regra "Ao adicionar
  campo novo"). Best-effort em streaming (usage não somado — gap conhecido).

## Validação

Harness valida com Zod no entrypoint do worker BullMQ. Campo ausente ou tipo
errado → job vai para `failed` queue com motivo estruturado.

## Erros comuns

- `execution_mode` ausente → "ZodError: Required" (Wave 7 fecha gap G1)
- `workspace_id` não-UUID → "ZodError: Invalid uuid" (Wave 7 fecha gap G3)
- `idempotency_key` aleatório → duplicação de execuções em retry
