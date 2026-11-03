---
name: harness-llm
glob: "{src/integration/llm/**,src/reasoning/**,src/runtime/**}"
description: Roteamento LLM (OpenAI + Gemini, ADR-021). Métricas por provider.
priority: 2
---

# Regra: LLM providers (ADR-021)

## Providers V1

- **OpenAI** — primário
- **Gemini** — secundário; failover
- **Anthropic Claude** — pós-V1 (avaliação)

## Adapter pattern

Não chamar SDK do provider direto em `reasoning/` ou `runtime/`. Sempre via
adapter (`src/integration/llm/<provider>/...`):

```ts
interface LLMAdapter {
  complete(prompt, options): Promise<LLMResponse>;
  stream(prompt, options): AsyncIterable<LLMChunk>;
  embeddings?(text): Promise<number[]>;
}
```

## Métricas obrigatórias

Por chamada:
- `llm.provider` (openai | gemini | claude)
- `llm.model_id`
- `llm.duration_ms`
- `llm.input_tokens`, `llm.output_tokens`
- `llm.cost_estimate_usd`
- `llm.error_code` (se aplicável)

## Failover

- OpenAI 429/5xx → tentar Gemini
- Gemini 429/5xx → tentar OpenAI
- Ambos down → `E_INFRA_LLM_ALL_DOWN` + alerta crítico

## NUNCA

- Logar prompt completo (PII potencial). Redact com Pino.
- Usar credencial sem vault.
- Chamar provider sem timeout.
