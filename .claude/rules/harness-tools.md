---
name: harness-tools
glob: "src/tools/**"
description: Tools do harness. Tools de mutação têm duplo caminho (ADR-006).
priority: 1
---

# Regra: src/tools/

## Categorias

- **Leitura** — sempre executam direto: `read-calendar`, `list-appointments`, `search-faq`, `read-profile`.
- **Mutação** — `create-appointment`, `cancel-appointment`, `reschedule-appointment`, `waitlist-add`, `send-message`. DEVEM implementar `executeOrPropose()` (ADR-006).
- **Sinalização** (STOP) — `request-human`. Sempre escala, idêntica em todos os modos.

## Registry (SKILLS-05)

Tools ARE skills (manifest-based). The single canonical store is
`UnifiedToolRegistry` (`src/tools/unified-registry.ts`) — it stores
`LoadedSkill` and exposes both a `ToolDefinition[]` view (`all()`/`resolve()`
for the executor) and a `LoadedSkill[]` view (`list()` for MCP outbound). The
legacy `ToolRegistry` + `SkillRegistry` pair and the per-tool `.tool.ts`
wrappers were removed. Each skill `index.ts` is self-contained; mutation
business logic stays in `src/tools/<cat>/<name>.mutation.ts` and is wired via
`mutationExecute(<mutation>)`.

## executeOrPropose (ADR-006)

Toda tool de mutação DEVE expor:

```ts
abstract executeOrPropose(
  params: ParamsT,
  context: ExecutionContext,
  mode: 'manual_assisted' | 'copilot' | 'autonomous_supervised'
): Promise<ToolResult | ToolProposal>;
```

- `autonomous_supervised` → executar; retorna `ToolResult`.
- `manual_assisted` / `copilot` → retornar `{ proposal: { action, params } }`, sem efeito.

## EM-03 wiring (issue #44 POC, 2026-06-02) — LIVE

`execution_mode` parsing do payload BullMQ + propagação até
`ToolContext.execution_mode` está LIVE (C8 ✓ + EM-03 ✓):

- Handler lê `payload.execution_mode` (default `autonomous_supervised`).
- Propaga para `AgentExecutionContext.executionMode`.
- Bridge `mutationExecute` (em `src/tools/_shared/mutation-tool.ts`)
  converte o context do agent em `ToolContext` e chama `executeOrPropose`.
  Cada skill `index.ts` registra `execute: mutationExecute(<mutation>)`.
- Tool em draft → retorna `{ success: true, data: { proposal } }`.
- Handler usa `extractProposal()` para hoist o proposal no acumulador
  per-execução, serializado em `/complete.proposals[]`.

**Estado (C9 landed):** as 5 mutation tools (`create-appointment`,
`cancel-appointment`, `reschedule-appointment`, `send-message`,
`waitlist-add`) passam TODAS por `executeOrPropose` via `mutationExecute`
— backend recebe `proposals[]` com itens de qualquer das 5 nos modos
draft (`manual_assisted` / `copilot`).

## Idempotency-Key (ADR-023)

Toda mutação real DEVE incluir `Idempotency-Key` ao chamar backend/externos:

```
key = sha256(execution_id : step_index : tool_name : canonical(params))      # ADR-015
# harness: step_index pinned em 0 p/ mutações de calendário (params idênticos = duplicata genuína).
# canonical(params) = JSON com chaves ordenadas recursivamente (ver canonicalize() em mutation-tool.ts).
```

NÃO usar UUID aleatório.

## Testes

- Leitura: roteamento + erros conhecidos (4xx, 5xx do backend).
- Mutação: comportamento por modo (autonomous, draft).
