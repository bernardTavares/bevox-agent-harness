# LLM Recorder / Replay

Sistema de gravação determinística de chamadas LLM (request + response + timing) para uso em testes, golden sets e demos sem custo. Inspirado em [`@mastra/_llm-recorder`](https://github.com/mastra-ai/mastra).

## Quando usar

- **Testes determinísticos** de reasoning engines (`ReAct`, `Plan&Execute`, `ReWOO`, `Reflexion`) sem gastar tokens reais a cada run.
- **CI** — replay zero-cost, falha previsível quando o request muda de forma incompatível com a cassette.
- **Golden sets** para avaliação de prompt/engine drift.
- **Demos** offline sem dependência de provider.

## Três modos

Controlados por `LLM_RECORDER_MODE`:

| Modo          | Comportamento                                                                                                | Quando usar                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `passthrough` | (default) Factory devolve o gateway composto inalterado. Zero diff vs main.                                  | Produção, dev local "como hoje".         |
| `record`      | Decorator outermost que: cassette hit → serve da fixture; miss → chama upstream, grava entry, devolve.       | Gerar fixture nova ou regravar uma stale. |
| `replay`      | Decorator terminal que serve só de cassette. Miss → `CassetteMissError`, **não** chama nenhum provider.       | Testes em CI, suítes determinísticas.    |

## Composição

```
LLMRecorder (modo record)        ┐
   ├─ RetryDecorator             │  Cadeia da factory atual,
   │    ├─ CircuitBreakerDecorator │  preservada em todos os modos.
   │    │    └─ adapter          ┘
   │
LLMReplayer (modo replay)         — bypass total: nunca toca adapter.
```

O recorder fica na **borda externa**: cassettes capturam o comportamento composto (retries, circuit short-circuits, etc.).

## Formato de cassette

JSON versionado em `tests/fixtures/cassettes/<scope>/<name>.cassette.json`:

```json
{
  "schema_version": "1",
  "name": "example/hello-world",
  "created_at": "2026-05-14T12:00:00.000Z",
  "entries": [
    {
      "request_hash": "<sha-256 hex>",
      "request_summary": { "model": "...", "n_messages": 2, "n_tools": 0, "has_response_schema": false },
      "response": { /* shape de LLMResponse — content, tool_calls, usage, latency_ms, ... */ },
      "recorded_at": "..."
    }
  ]
}
```

### Hash determinístico

`hashRequest(options, model)` faz:

1. Constrói objeto canônico `{ model, messages, tools, response_schema, temperature, max_tokens }`.
2. `stableStringify` ordena chaves de objetos lexicograficamente e descarta `undefined`.
3. SHA-256 do JSON resultante.

Resultado: chaves desordenadas em `messages[].{role,content}` ou `responseSchema` produzem o **mesmo hash**. Ordem dos elementos em arrays (`messages`, `tools`) é preservada — é semanticamente relevante.

## Como gravar uma cassette nova

```bash
# Single test
LLM_RECORDER_MODE=record \
LLM_RECORDER_CASSETTE_NAME=reasoning/react-happy-path \
npm run test:unit -- tests/unit/reasoning/react.test.ts

# Worker em dev (smoke E2E)
LLM_RECORDER_MODE=record \
LLM_RECORDER_CASSETTE_NAME=manual/smoke \
npm run dev
# Em outra shell:
npm run docker:up && npm run smoke:enqueue
```

A cassette é criada/atualizada em `tests/fixtures/cassettes/<name>.cassette.json`. Entries com o mesmo `request_hash` são substituídas (idempotência — re-record = mesmo diff zero).

## Usando em testes

```typescript
import { useCassette } from "../helpers/cassette-fixture";

describe("ReAct engine", () => {
  const cassette = useCassette("reasoning/react-happy-path");

  it("completes a 3-step plan", async () => {
    const engine = new ReActEngine(cassette.gateway());
    const result = await engine.run(somePlan);
    expect(result.steps).toHaveLength(3);
  });
});
```

`useCassette` devolve um `LLMReplayer` no modo default. Modo `record` requer instanciar `LLMRecorder` diretamente — o helper recusa porque o upstream a injetar é decisão do teste.

## Política de revisão

Toda PR que adiciona/modifica cassette **exige**:

1. **Code review humano** — sanitizer é defesa em profundidade, NÃO substitui inspeção visual de PII / chaves em `response.content` e `tool_calls[].arguments`.
2. **Diff legível** — cassettes são pretty-printed (2 espaços, newline final) por padrão para minimizar ruído.
3. **Bounded size** — limite recomendado: ≤ 50 entries por cassette, ≤ 500KB por arquivo. Cassettes maiores indicam que o teste cobre demais escopo.

O sanitizer remove automaticamente padrões conhecidos antes da escrita:

- OpenAI: `sk-...`, `sk-proj-...`
- Anthropic: `sk-ant-...`
- Google AI: `AIza...`
- HTTP: `Authorization: Bearer ...`
- JWTs: `eyJ...eyJ...sig`

**Importante**: API keys nunca alcançam `LLMResponse` por construção (vivem em headers HTTP, manipulados pelo adapter). O sanitizer existe para PII em `content`/tool-call arguments e como defesa contra leakage acidental de um adapter mal-comportado.

## Invalidar / regravar

```bash
# Apagar entries inteiras → primeiro run no modo record reconstrói
rm tests/fixtures/cassettes/reasoning/react-happy-path.cassette.json
LLM_RECORDER_MODE=record LLM_RECORDER_CASSETTE_NAME=reasoning/react-happy-path \
  npm run test:unit -- tests/unit/reasoning/react.test.ts
```

## Limitações conhecidas

- **`latency_ms` no replay é o valor gravado**, não wall-clock real. Testes que asseguram latência real precisam de clock injetável em camada mais alta.
- **Determinismo do provider** — mesmo com `temperature: 0`, alguns providers retornam tokens/IDs ligeiramente diferentes entre chamadas. Cassettes podem precisar de regravação após major version bump do SDK do provider.
- **Schema `cassette_version`** — bump da literal `"1"` é breaking change. Migration requer regravação batch.

## Versionamento

`schema_version: "1"` é a versão corrente. Mudanças backwards-compatible (campos novos opcionais) **não** exigem bump. Mudanças que invalidam cassettes existentes (rename/remove de campo obrigatório, mudança de regex de `request_hash`) exigem:

1. Bump da literal em `cassette-schema.ts`.
2. Script de migração em `scripts/cassette-migrate-v<N>-to-v<N+1>.mjs`.
3. Re-record completo de fixtures via CI dedicado.

## Riscos e mitigações

| Risco                                          | Mitigação                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Secret leak em cassette commitada              | Sanitizer + review obrigatório + scanner periódico                                                       |
| Hash colide entre requests semanticamente ≠    | SHA-256 com canonicalização determinística — colisão desprezível                                         |
| Cassettes ficam enormes e poluem repo          | Política ≤ 50 entries / 500KB; CI alerta                                                                  |
| Modo `record` por engano em CI gasta tokens    | `LLM_RECORDER_REQUIRE_NAME=true` (default) força nome explícito; CI define `LLM_RECORDER_MODE=replay`     |
| Sanitizer remove conteúdo legítimo             | Regex específicas (prefixos `sk-`, `AIza`); testes de não-regressão garantem strings benignas passam      |
| Drift de cassettes quando provider muda formato | `schema_version` permite migration explícita; regravar todas em batch se Zod parse falhar                |
