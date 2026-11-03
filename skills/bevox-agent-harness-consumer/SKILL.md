---
name: bevox-agent-harness-consumer
description: |
  Use ao integrar um projeto Bevox com o bevox-agent-harness para executar IA
  (raciocínio, RAG, tools, execução de agentes). Cobre payload BullMQ, MCP tools,
  modos de autonomia (ADR-006), e callback /complete. NÃO use ao desenvolver o
  harness em si.
---

# bevox-agent-harness — Consumer Integration Skill

Você está num projeto Bevox que precisa **executar IA**. O harness é o motor:
recebe contexto (mensagem, perfil de cliente, regras), raciocina via LLM
(OpenAI/Gemini, ADR-021), chama tools e devolve resultado via callback `/complete`.

## Quando usar

- Você é o backend e está publicando jobs de execução IA.
- Você é o console e quer inspecionar execuções em curso.
- Você é o mobile/web e precisa simular execução (modo dev).
- Você está debugando handoff IA→humano.

## Quando NÃO usar

- Você está **modificando o harness em si** — leia `prds/modulos/bevox-harness-prd-v1.md`,
  ADR-006, ADR-021. Use os agents internos do repo.

## Modelo mental em 30 segundos

```
backend ──(BullMQ job)──► harness ──tools──► (calendar, messaging, profile)
   ▲                         │
   └── HTTP /complete ◄──────┘
```

- **Identidade:** `workspace_id` (UUIDv7, ADR-001/003) — nunca `account_id`.
- **Execução:** harness recebe payload BullMQ; raciocina; chama tools; `/complete`.
- **Modos** (ADR-006): `manual_assisted`, `copilot`, `autonomous_supervised`.
- **MCP:** `bevox-mcp` bin para outras ferramentas/consumidores.

## Regras invioláveis

1. **`execution_mode` é obrigatório** no payload (ADR-006).
2. **`workspace_id` é UUIDv7** (ADR-001). Strings "acc_123" são bug.
3. **Idempotency-Key derivado de evento** (ADR-023). Não use UUID aleatório.
4. **AISuggestion é responsabilidade do backend** (ADR-007).
5. **NÃO chamar `graph.facebook.com` direto.** Mensagens saem via meta-api.

## Estrutura

- `references/mcp-tools.md` — tools do MCP server do harness
- `references/execution-payload.md` — schema do payload BullMQ
- `references/error-codes.md` — códigos de erro padronizados
