---
name: harness-payload
glob: "{src/integration/**,src/runtime/**}"
description: Payload BullMQ. _shared/ADR-021 (organizationId) + ADR-019 harness (organization_id-native).
priority: 1
---

# Regra: payload BullMQ

Ver `skills/bevox-agent-harness-consumer/references/execution-payload.md`.

Campos obrigatórios (pós-ADR-019 organization_id-native):

- `execution_id: z.string()` (UUIDv7, `_shared`/ADR-016)
- `execution_token: z.string()` (token efêmero, validado em callbacks via `X-Execution-Token`)
- `organization_id: z.string().uuid()` (canon `_shared`/ADR-021, harness/ADR-019; **nunca** `account_id` / `workspace_id`)
- `execution_mode: z.enum(["manual_assisted","copilot","autonomous_supervised"])` (canon `_shared`/ADR-006 — 3 modos)
- `messages: z.array(...)` (histórico recente da conversa)
- `agent_config: { system_prompt, default_model? }`
- `skills: string[]` (PERM-05: **allowlist** plano de tool names; ver §"Layer-2 permission model" abaixo)
- `account_denied_tools: string[]` (PERM-05: **blacklist** plano, opcional)

## Léxico legado proibido

- `account_id` / `account` — retirado pós ADR-019 / Wave 7
- `workspace_id` / `workspaces` — retirado pós `_shared`/ADR-021 (organization tenant canon)
- Toda introdução nova destes nomes em `src/` ou `migrations/` é **bug**
- Migrations 001–010 ainda contêm referências históricas de `account_id`,
  removidas em 011 (`011_organization_id_tenancy.sql`). Não revertir.

## Layer-2 permission model (PERM-05, auditoria 2026-06-02)

Modelo semântico canônico para `skills` + `account_denied_tools`:

- **`account_denied_tools` é a blacklist autoritativa** — tools listados aqui
  são SEMPRE negados em Layer 2 (`EXECUTION_CONTEXT_DENIED`), independente
  de qualquer allowlist.
- **`skills` é uma allowlist plana** de tool names permitidos pela
  organização. Quando NÃO vazia, o harness deriva o complemento
  (`UnifiedToolRegistry.all()` \ `skills`) e o adiciona ao denylist final.
- **`skills` vazio (default)** = sem filtro de allowlist; só a blacklist
  explícita aplica (comportamento legado, retrocompat).
- **Conjunto final de Layer-2 denied** = união deduplicada de
  `account_denied_tools` ∪ `complement(toolRegistry, skills)`.

Derivação em `src/permissions/permission-context.ts:deriveAccountDeniedTools`.
Aplicada pelo `evaluator.evaluatePermission` em Layer 2 (reason
`EXECUTION_CONTEXT_DENIED`).

## Status de implementação (auditoria 2026-06-02)

- `organization_id` no payload: **LANDED** (236 hits `organizationId` no `src/`, 0 `account_id`/`workspace_id`)
- `execution_mode` parseado em runtime: **LANDED** (commit a22de19 / #29) —
  `executionPayloadSchema` declara `ExecutionModeSchema.optional().default("autonomous_supervised")`,
  propagado para `AgentExecutionContext.executionMode` e consumido pelo bridge
  `wrapMutationTool`. C8 fechado.
- `idempotency_key` content-derived (sha256 + canonical(params), ADR-015)
  nas 5 mutation tools + 6 call-sites de `sendComplete` (discriminado por
  desfecho terminal): **LANDED** (plano mutation-stack, 2026-06-02). C10
  fechado. `deriveIdempotencyKey()` agora recebe `params` e produz sha256.
- `accountDeniedTools` populado a partir do payload (PERM-05): **LANDED
  POC (issue #43)** — main path (`buildPermissionContext` com
  `allKnownToolNames`) + Model-C path (call site computa e propaga via
  `DispatchModelCArgs.accountDeniedTools`). Follow-on: integration test
  end-to-end backend→harness→audit + revisitar o contrato `skills`
  (potencial migração futura para shape estruturado `{ allowed, denied }`).
- `max_cost_usd` (teto de custo J9) + `HARNESS_MAX_COST_USD` (default env):
  **LANDED** (plano execution-bounding, 2026-06-02). Payload override (USD) >
  default env. Abort cooperativo no surface loop + `synthesize` bounded por
  `runWithTimeout`. Desfechos `strategy:"aborted_cost"`/`"aborted_timeout"`
  emitidos pelo ÚNICO call-site de erro (sem double-complete). Non-retryable
  para `cost_ceiling` via retenção da dedup key. **Aberto:** retry real depende
  do producer enfileirar com `attempts > 1` (consumer não declara) — sem isso o
  `wall_clock_timeout` perde a execução; e não há DLQ (v2) p/ bound do retry-loop.

## Ao adicionar campo novo

- Zod schema + tipo TS gerado
- Documentar em `skills/bevox-agent-harness-consumer/references/execution-payload.md`
- Obrigatório → breaking change → bump major + ADR no canon
- Opcional → minor

## Validação

Worker BullMQ valida via Zod. Payload improcessável (Zod-inválido ou oversize)
→ `parseExecutionPayload` lança `UnprocessablePayloadError` (estende
`UnrecoverableError`); o handler relança (NÃO retorna silenciosamente) e o worker
o roteia para o `failed` set do BullMQ como RETENÇÃO LOCAL (`removeOnFail.age`,
default 24h — auxílio forense / fallback Redis-down, NÃO a dead-letter
authoritativa). A dead-letter AUTHORITATIVA vive no BACKEND como
`status='dead_letter'`, escrita pelo `worker.on("failed")` na tentativa FINAL do
`attempts:7` (transiente esgotado, `action='retry_exhausted'`) ou em poison
salvageável — via `updateStatus(..., 'dead_letter', meta)` com `Idempotency-Key`.
Abort de wall-clock/cost (J8) é terminal e NUNCA vira dead_letter (classificado
por `err.name === "ExecutionAbortError"`). NÃO usar `sendComplete(strategy:'failed')`
como sinal dead-letter (ele NÃO seta `status='dead_letter'` e não acende a replay
UI de staff). Logging é `logger.error` = Pino level **50 (ERROR)**, não fatal.
NÃO há fila dedicada `bevox.harness.dead-letter` no harness — a dead-letter é o
estado backend; a retenção do `failed` set é só local; uma DLQ dedicada fica
diferida a v2.
