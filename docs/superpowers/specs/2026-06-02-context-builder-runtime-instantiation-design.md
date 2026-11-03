# ContextBuilder Runtime Instantiation Design

> **Spec ID:** `2026-06-02-context-builder-runtime-instantiation-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Haiku 4.5) com instruções do founder em 2026-06-02
> **Escopo:** audit finding CTX-01 (ALTO) / bernardTavares/bevox-harness#39
> **Estimate:** 12–16 h (3–4 fases)
> **Issue:** bernardTavares/bevox-harness#39

---

## §1. Context

### Hoje: código morto

O subsistema `ContextBuilder` (`src/context/context-builder.ts:8–29`) e suas 5 camadas semânticas (base config, memory, calendar, history, rules) foram implementadas como uma **solução de composição de prompt modular e priorizada** descrita no PRD §5.5. As camadas existem, têm testes isolados, e respeitam prioridades, compressibilidade e token budgets. No entanto, **nunca são instanciadas em nenhum caminho de execução vivo**.

O caminho de produção atual (`dispatchModelC`, linhas ~790–850 em `execution-handler.ts`) injeta a composição de prompt via `composeSystemPrompt(rawSystemPrompt, sdrProfile)` apenas — uma **composição de 2 args** que ignora as 5 camadas e produz:

```
systemPrompt = rawSystemPrompt + "\n\n" + SDR_DOCTRINE
```

O ContextBuilder era o candidato natural para orquestrar essa composição, mas a integração nunca saiu do backlog.

### Impacto em produção

1. **Perda de sinal**: O agente raciocina com um prompt desprovido de contexto semântico de memória (recalls de fatos anteriores), calendário (slots de agendamento), histórico (janela de mensagens comprimida), e regras (políticas por agente). O pipeline de 10 passos descrito no PRD §5.2–5.5 é parcialmente executado.

2. **Promessa não cumprida na GA**: A documentação (`CLAUDE.md`, `harness-payload.md`) descreve o ContextBuilder como operacional, criando falso senso de confiança antes da piloto.

3. **Correção é trivial e de alto valor**: As camadas existem, os testes passam, o builder respeita token budgets. A única lacuna é ligar o sistema à execução.

### Arquivos relevantes

- **Builder:** `src/context/context-builder.ts:17–29` (método `.build()` nunca chamado)
- **Camadas:** `src/context/layers/{base-config,memory,calendar,history,rules}.layer.ts` (todas implementadas, todas testadas isoladamente)
- **Tipos:** `src/context/types.ts` (ContextInput, ContextBlock, BuiltContext bem-definidos)
- **Caminhos vivos:** `src/runtime/execution-handler.ts:790–795` (ReAct genérico), `:207–245` (Model-C), `:1100–1150` (resumption)
- **Composição:** `src/sdr/compose.ts` (composeSystemPrompt, single seam para doutrina SDR)
- **Audit:** `docs/audits/runtime-gap-audit-2026-06-02.md` §CTX-01

---

## §2. Problem statement

**ContextBuilder é código não-operacional:**

1. Não há chamada `new ContextBuilder(...)` em nenhum arquivo do `src/runtime/` (grep confirmado em issue).
2. Não há chamada `.build(input)` em nenhum caminho de execução.
3. As 5 camadas são compiladas, testadas em isolamento (`.test.ts` para cada uma), mas nunca consumidas.
4. O prompt vivo é produzido por `composeSystemPrompt(rawSystemPrompt, sdrProfile, ...)`, que é **desacoplado** do ContextBuilder.

**Evidência concreta:**

- `execution-handler.ts:933` — ReAct path: `const composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);`
- `execution-handler.ts:239` — Model-C path: `agentContext.systemPrompt = composeSystemPrompt(rawSystemPrompt, sdrProfile, null, undefined, fsmProjection);`
- `execution-handler.ts:1266` — Workflow resumption: `agentContext.systemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);`
- `context-builder.ts:17–29` — Método `.build()` existe, mas nunca é `await`-ado em lugar nenhum.

**Gap de contrato:**

O `ContextInput` (tipos.ts:1–23) define `agentConfig`, `executionId`, `organizationId`, `contactId`, `conversationKey`, `dispatchPayload`, opcionais `userMessage` e `tokenBudget`. Esses campos estão disponíveis em todos os 3 pontos de entrada (generic ReAct, Model-C, workflow resumption), mas nunca são montados e passados ao builder.

**Impacto de reasoning:**

Sem as camadas, agentes perdem:
- **Memory layer** (semantic facts / recalls): nenhuma injeção de fatos históricos
- **Calendar layer** (appointment context): nenhum slot estruturado de agendamento
- **History layer** (message windowing): nenhuma compressão de histórico longo
- **Rules layer** (agent-scoped policies): nenhuma restrição local de comportamento

O builder já respeita `max_context_tokens` (types.ts:8), mas esse limite nunca é aplicado em produção.

---

## §3. Goals & non-goals

### Goals

- [ ] Instanciar `ContextBuilder` com todas as 5 camadas em todos os 3 caminhos de execução (ReAct genérico, Model-C SDR, workflow resumption).
- [ ] Montar `ContextInput` correto com campos live em cada entry point.
- [ ] Chamar `await builder.build(input)` antes de `composeSystemPrompt()`.
- [ ] Dobrar o resultado (`BuiltContext.systemPrompt` + blocks) no prompt final **antes** da doutrina SDR.
- [ ] Respeitar token budget: ler `max_context_tokens` do payload de dispatch e passar ao builder.
- [ ] Emitir observabilidade: span `context.build` com layer names, token counts, compression flag.
- [ ] Fail-open: erros de camada não abortam execução (logged como warning, layer omitido do output).
- [ ] Testes: unit + integração cobrindo builder instantiation em todos 3 paths e E2E com todas 5 camadas ativas.
- [ ] Documentação: atualizar `CLAUDE.md` e `harness-payload.md` para refletir ContextBuilder como vivo (não "Phase 5"/"future").

### Non-goals

- [ ] Modificar as assinaturas das 5 camadas ou de `composeSystemPrompt()` (elas estão corretas).
- [ ] Implementar factory pattern para as camadas (exportar funções de instância já existe em `layers/index.ts`).
- [ ] Adicionar nova camada no scope desta spec.
- [ ] Otimizar performance das camadas (já não é critical path).
- [ ] Mudar schema de payload (`executionPayloadSchema` em `execution-handler.ts`).

---

## §4. Architecture proposal

### Modelo de integração

O ContextBuilder será instanciado **uma única vez por execution** e reutilizado em todos os pontos de recomposição de prompt (entry + Model-C, recomposição em recomposição de estado, etc).

**Ponto de entrada único:** após a criação de `SessionStore` e antes do pipeline de raciocínio (`execution-handler.ts:1050–1110` approx). É onde temos todos os inputs já prontos (agentConfig, organizationId, contactId, conversationKey, messages da session).

**Fluxo:**

```
execution-handler.ts:~950 — agentContext criado
    ↓
execution-handler.ts:~1050 — NOVO: Instanciar ContextBuilder com todas 5 camadas
    ↓
execution-handler.ts:~1060 — NOVO: Chamar builder.build(contextInput)
    ↓
execution-handler.ts:~1070 — NOVO: Obter BuiltContext = { systemPrompt, totalTokens, layersUsed, compressed }
    ↓
execution-handler.ts:~1080 — MODIFICADO: Recompor prompt:
       contextPrompt = BuiltContext.systemPrompt  (blocos de camadas montados)
       basePrompt = systemPrompt  (base user-provided)
       final = basePrompt + "\n\n" + contextPrompt + "\n\n" + SDR_DOCTRINE (se sdrProfile)
    ↓
execution-handler.ts:~1085 — agentContext.systemPrompt = final
    ↓
execution-handler.ts:~1090 — NOVO: Emitir span context.build com atributos
```

### Arquitetura de dependências

```
execution-handler.ts (entry point manager)
├── ContextBuilder (orquestrador)
│   ├── BaseConfigLayer (priority 10, non-compressible)
│   ├── RulesLayer (priority 20, non-compressible)
│   ├── CalendarLayer (priority 30, compressible)
│   ├── MemoryLayer (priority 40, compressible)
│   └── HistoryLayer (priority 50, compressible)
├── composeSystemPrompt (SDR doctrine injection) → fica APÓS ContextBuilder
├── enforceBudget (token limit enforcement) → fica APÓS composeSystemPrompt
```

### Detalhes de implementação

**1. Factory para instanciar builder (novo arquivo: `src/context/builder-factory.ts`):**

```typescript
// builder-factory.ts
export function createContextBuilder(options?: {
  globalMaxTokens?: number;
}): ContextBuilder {
  const layers = [
    new BaseConfigLayer(),
    new RulesLayer(),
    new CalendarLayer(),
    new MemoryLayer(),
    new HistoryLayer(),
  ];
  return new ContextBuilder(layers, options);
}
```

**2. Montagem de ContextInput em execution-handler.ts:**

Em cada caminho (ReAct, Model-C, resumption), montar:

```typescript
const contextInput: ContextInput = {
  executionId: execution_id,
  organizationId: organizationId,
  contactId: contactIdCtx, // já parseado em ~965
  conversationKey, // já extraído em ~924
  agentConfig: {
    systemPrompt: systemPrompt, // base user prompt
    maxContextTokens: budgetTokens, // do payload ou default
  },
  dispatchPayload: payload, // passthrough completo
  userMessage: inboundMessage, // última msg do usuário (para MemoryLayer embedding)
  tokenBudget: budgetTokens, // dica para Memory limitar D.3
};
```

**3. Chamada ao builder (execution-handler.ts ~1050):**

```typescript
const contextBuilder = createContextBuilder({ globalMaxTokens: DEFAULT_GLOBAL_MAX_TOKENS });
const builtContext = await contextBuilder.build(contextInput);

rootSpan.setAttribute("context.layers.count", builtContext.layersUsed.length);
rootSpan.setAttribute("context.layers.used", builtContext.layersUsed.join(","));
rootSpan.setAttribute("context.tokens.total", builtContext.totalTokens);
rootSpan.setAttribute("context.compressed", builtContext.compressed);
```

**4. Recomposição de prompt (execution-handler.ts ~1070):**

```typescript
// Antes (linha ~933 / ~239 / ~1266):
agentContext.systemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);

// Depois:
const contextPrompt = builtContext.systemPrompt; // Já montado pelo builder
const doctrinedPrompt = composeSystemPrompt(systemPrompt, sdrProfile, ...);
agentContext.systemPrompt = contextPrompt + "\n\n" + doctrinedPrompt;
// Resultado = BaseConfig + Rules + Calendar + Memory + History + SDR_DOCTRINE + [FSM se Model-C]
```

**5. Pontos de chamada (3 caminhos):**

- **ReAct genérico** (`execution-handler.ts:~1000–1110`): após `agentContext` criado, antes do loop de raciocínio.
- **Model-C** (`execution-handler.ts:~200–250`): **após** carregamento do estado FSM (novo sesamo do correlationProbe), **antes** da recomposição final. Aqui, `systemPrompt = systemPrompt` (base) + FSM_PROJECTION (já injetado em ~245).
- **Workflow resumption** (`execution-handler.ts:~1100–1150`): após loading do estado salvo, **antes** do loop de raciocínio.

### Token budget enforcement (revisitado)

O builder já computa `totalTokens` em cada camada e aplica compressão proporcional se `totalTokens > limit` (context-builder.ts:24–29).

Atualmente, `enforceBudget()` é chamado **pós-composição** (linha ~1312) e reduz o systemPrompt final. **Novo fluxo:**

1. Builder respeita limite em fase 1 (layout: quais blocos + quão comprimidos).
2. `enforcebudget()` é chamado **após** composeSystemPrompt + FSM (se Model-C) como camada 2 de defesa (em caso de overhead não previsto).

Assim, a maioria das execuções sai com budget correto do builder; `enforceBudget()` é garantia, não caminho feliz.

---

## §5. Implementation plan

### Phase 1 — Factory + builder instantiation (5h)

**Files to create/modify:**

- **Create:** `src/context/builder-factory.ts` (factory para instanciar builder com todas 5 camadas)
  - Export `createContextBuilder(options?): ContextBuilder`
  - Use classe existente `ContextBuilder` + imports de `layers/index.ts`

- **Modify:** `src/runtime/execution-handler.ts`
  - Import `createContextBuilder`
  - Import `ContextInput` from `src/context/types.ts`
  - Add builder instantiation no início do caminho ReAct (after `agentContext` creation, ~line 972–1000)
  - Call `await builder.build(contextInput)` and store result
  - Wire token budget from payload (`max_context_tokens` field, lines ~1304–1310 already parse this)

- **Modify:** `src/runtime/execution-handler.ts` (Model-C path recomposição)
  - Same builder instance (reuse from Phase 1)
  - Call builder.build() again **after** FSM projection is loaded (line ~224) to include FSM context in builderInput
  - Fold result into systemPrompt before final composeSystemPrompt (line ~239)

- **Modify:** `src/runtime/execution-handler.ts` (workflow resumption)
  - Same builder instance
  - Build again after state load with resumption context
  - Inject into systemPrompt before resumption loop

**Tests (unit, existing mock framework):**

- `tests/unit/runtime/execution-handler.context.test.ts` (new)
  - Mock all 5 layers to return fixed blocks
  - Verify builder is instantiated once per execution
  - Verify `build()` is called with correct ContextInput shape
  - Verify returned systemPrompt is injected before composeSystemPrompt

**Estimate:** 5h (scaffold + wiring in 3 paths + unit layer instantiation tests)

---

### Phase 2 — Layer integration + observability (4h)

**Files to modify:**

- **Modify:** `src/runtime/execution-handler.ts`
  - Emit otel span `context.build` with attributes:
    - `context.layers.count`: number of layers that produced blocks
    - `context.layers.used`: comma-separated layer names
    - `context.tokens.total`: total tokens in built context
    - `context.tokens.limit`: from `max_context_tokens` or default
    - `context.compressed`: boolean flag from `BuiltContext.compressed`
  - Add error handling: wrap `builder.build()` in try-catch, log warnings if layer fails, continue (fail-open)

- **Modify:** `src/context/context-builder.ts`
  - Ensure `.build()` propagates layer errors as non-fatal (catch per-layer, collect errors)
  - Log which layers succeeded/failed

- **Update:** `CLAUDE.md`
  - Remove "Phase 5"/"future" language for ContextBuilder
  - Document as "ContextBuilder is live in all execution paths (ReAct, Model-C, workflow resumption)"

- **Update:** `.claude/rules/harness-payload.md`
  - Document `max_context_tokens` from dispatch payload as operative (not "will be used")
  - Document ContextBuilder as active system, not deferred

**Tests (integration):**

- `tests/integration/context-builder.integration.test.ts` (enhance existing)
  - Mock real layer outputs (calendar client + memory client returns)
  - Execute full job with builder enabled
  - Verify final prompt contains **all 5 layer outputs + SDR doctrine**
  - Verify span attributes are emitted correctly

**Estimate:** 4h (observability + logging + doc updates + integration test)

---

### Phase 3 — Token budget + compression validation (3h)

**Files to modify:**

- **Modify:** `src/runtime/execution-handler.ts`
  - Pass `budgetTokens` (from payload parse at ~1304) to `ContextInput` → `agentConfig.maxContextTokens`
  - Ensure builder sees the limit

- **Modify:** `src/context/context-builder.ts`
  - Verify compression logic (already present at lines 24–29, 32–64)
  - Test under tight budgets (e.g., `max_context_tokens=500`)

**Tests (unit + integration):**

- `tests/unit/context/context-builder.compression.test.ts` (new or enhance existing)
  - Test compression with budget < total tokens
  - Verify non-compressible blocks (BaseConfig, Rules) are never truncated
  - Verify compressible blocks are proportionally reduced
  - Verify `compressed` flag is set correctly

- `tests/integration/context-builder-budget.test.ts` (new)
  - Execute with `max_context_tokens=500` (very tight)
  - Verify final prompt fits within budget
  - Verify metric `context.tokens.used` ≤ limit

**Estimate:** 3h (compression test fixtures + budget enforcement validation)

---

### Phase 4 — Regression testing + polish (2-3h)

**Files to test:**

- Run existing agent test suites to ensure no breakage from new context injection
- Verify ReAct path tests still pass (context is transparent to agent logic)
- Verify Model-C SDR tests still pass (FSM + context cohabitation)

**Files to document:**

- Update CLAUDE.md §Context layers with architecture diagram (text or ASCII art)
- Add troubleshooting section to harness-payload.md (what to do if builder fails)

**Estimate:** 2-3h (regression testing + final doc polish)

---

## §6. Testing strategy

### Unit tests

**File:** `tests/unit/runtime/execution-handler.context.test.ts` (new)

- Test 1: `Builder instantiation in ReAct path`
  - Mock ContextBuilder.build() to return fixed block
  - Call execution-handler ReAct path
  - Assert builder was called with correct ContextInput (executionId, organizationId, conversationKey, etc.)
  - Assert returned context is folded into systemPrompt

- Test 2: `Builder instantiation in Model-C path`
  - Mock correlationProbe to return suspendToken
  - Mock WorkflowStateStore to return FSM state
  - Call dispatchModelC path
  - Assert builder.build() is called after FSM load
  - Assert systemPrompt = base + context + FSM + SDR_DOCTRINE in that order

- Test 3: `Builder instantiation in workflow resumption`
  - Mock workflow resumption entry
  - Assert builder.build() is called before FSM loop

**File:** `tests/unit/context/context-builder.compression.test.ts` (new or enhance)

- Test 1: `No compression when under budget`
  - Mount 3 blocks with 100 tokens each, budget 500
  - Assert compressed = false, all blocks present

- Test 2: `Compression when over budget`
  - Mount 3 blocks (100, 150, 200 tokens), budget 200
  - Assert compressed = true
  - Assert non-compressible blocks unchanged
  - Assert compressible block reduced proportionally
  - Assert total ≤ budget

- Test 3: `Non-compressible blocks never truncated`
  - BaseConfig + Rules (both non-compressible) with 300 tokens
  - Calendar + Memory + History (all compressible) with 500 tokens
  - Budget 400 → assert Base+Rules full size, others trimmed to fit

### Integration tests

**File:** `tests/integration/context-builder.integration.test.ts` (existing, enhance)

- Test 1: `E2E with all 5 layers enabled`
  - Mock calendar client to return appointment block
  - Mock memory client to return 2-3 fact blocks
  - Execute full job (ReAct path)
  - Parse final prompt sent to Claude API
  - Assert all 5 layer sections present (## Configuracao base, ## Regras, ## Calendario, ## Memoria, ## Historico)
  - Assert SDR_DOCTRINE is present and **after** context layers

- Test 2: `Token budget respected in E2E`
  - Set `max_context_tokens=600` in payload
  - Execute with multi-block output from layers
  - Assert final prompt ≤ 600 tokens
  - Assert metric `context.tokens.used` logged

- Test 3: `Fail-open: layer error does not abort`
  - Mock MemoryLayer to throw error
  - Execute full job
  - Assert execution completes
  - Assert warning logged for MemoryLayer
  - Assert final prompt includes other 4 layers
  - Assert metric `context.layers.failed` emitted

### Regression tests

- Run existing ReAct agent tests (`tests/integration/reasoning/react.test.ts`)
- Run existing Model-C tests (if separate suite exists, else verify via e2e)
- Run existing workflow tests
- Assert all pass (no performance degradation, no prompt corruption)

---

## §7. Migration & rollback

### Activation

**Feature flag:** Not needed initially (builder is additive, fail-open on layer errors).

**Rollout strategy:**

1. **Phase 1+2 merge to main** — builder instantiated but all layer mocks in test
2. **Phase 3 merge** — budget enforcement enabled
3. **Phase 4 merge** — regression tests pass, doc updated, GA-ready

**Immediate effect after Phase 2 merge:**
- All executions (ReAct, Model-C, resumption) will have context layers injected into prompt
- If layer fails, warning logged, execution continues (fail-open)
- Observability span emitted regardless

### Rollback

If critical regression found:

1. **Option A (minimal):** Set `globalMaxTokens` to very high value in `createContextBuilder()` → builder still runs but produces no compression, layers included but massive prompt.
2. **Option B (safe):** Comment out `await builder.build()` call in execution-handler; revert to old `composeSystemPrompt()` alone.
3. **Option C (clean):** Feature flag `CONTEXT_BUILDER_ENABLED` in env, default true, set false to disable.

**No data loss** — builder output is append-only to system prompt, never modifies payload or state.

---

## §8. Risks & open questions

### Technical risks

1. **Layer performance:** MemoryLayer and CalendarLayer make DB/API calls. If slow, they block the execution pipeline. **Mitigation:** layers already have ~1s timeout in test mocks; production must enforce via context.Client timeouts.

2. **Prompt size explosion:** All 5 layers + SDR doctrine + FSM (Model-C) could exceed model context window. **Mitigation:** builder already compresses; `enforceBudget()` is second gate; tests validate final prompt fits.

3. **Compatibility with existing prompts:** User-provided `systemPrompt` (base config layer content) may already contain context-like sections. Duplication? **Mitigation:** BaseConfigLayer is priority 10 (first), user prompt becomes **first block**, not appended — no duplication by design.

4. **FSM + context interaction:** Model-C path already has FSM projection in systemPrompt (line 245). Adding layers could conflict. **Mitigation:** FSM is injected **after** ContextBuilder result (architecture §4 seam), so order is: Base + Rules + Calendar + Memory + History + SDR + FSM (correct).

### Scope questions

1. **Should we cache `BuiltContext` across multiple prompt recompositions in the same execution?** Today, builder is called once per execution. If execution loop re-composes prompt (e.g., re-planning), should we rebuild or reuse? **Decision for founder:** for Phase 1, build once at entry, reuse. Phase 2+ can add caching if latency profile shows it.

2. **Which layer errors are "expected" vs "bugs"?** E.g., memory DB timeout = expected (fail-open), NullPointerException in MemoryLayer = bug (should surface). **Decision for founder:** Phase 2 will distinguish by exception type; alarms on unexpected errors.

3. **How do we version ContextBuilder for future layer additions?** No versioning in builder constructor today. **Deferred:** out of scope for GA, future ADR.

### Integration risks

1. **Backend contract change:** If backend emits new fields in dispatch payload (e.g., `context_profile`, `memory_config`), executor must update `ContextInput` schema. **Mitigation:** `dispatchPayload` is passthrough field in ContextInput; easy to extend.

2. **Harness-backend dispatch callback:** Does `/complete` callback need to include layer usage stats? **Decision:** no change needed; `context.*` attributes go into otel span, not callback body.

---

## §9. Definition of done

- [ ] Phase 1 merged to main:
  - [ ] `builder-factory.ts` created and exported
  - [ ] `execution-handler.ts` installs builder in all 3 paths (ReAct, Model-C, resumption)
  - [ ] `ContextInput` correctly mounted with executionId, organizationId, contactId, conversationKey, agentConfig, dispatchPayload
  - [ ] Unit tests: builder instantiation verified in each path

- [ ] Phase 2 merged:
  - [ ] Observability span `context.build` emitted with all attributes (layers.count, layers.used, tokens.total, compressed, etc.)
  - [ ] Fail-open: layer errors logged as warnings, execution continues
  - [ ] Integration test: full E2E with all 5 layers producing output
  - [ ] `CLAUDE.md` and `harness-payload.md` updated to reflect ContextBuilder as live

- [ ] Phase 3 merged:
  - [ ] Token budget from payload (`max_context_tokens`) is read and passed to builder
  - [ ] Builder respects limit; blocks compressed if needed
  - [ ] Compression flag logged and verified in tests
  - [ ] `enforceBudget()` post-compose still works as secondary gate

- [ ] Phase 4 complete:
  - [ ] All existing ReAct agent tests pass (regression clear)
  - [ ] All existing Model-C tests pass
  - [ ] All existing workflow tests pass
  - [ ] No performance degradation (context layer build time << execution time)
  - [ ] Audit finding CTX-01 is formally closed

- [ ] **Acceptance criteria (functional):**
  - [ ] Executing a real job with `sdr_profile` includes all 5 context layers in final prompt sent to Claude API
  - [ ] Prompt order is correct: Base Config + Rules + Calendar + Memory + History + SDR Doctrine + (FSM if Model-C)
  - [ ] Token budget is enforced: final prompt ≤ `max_context_tokens` (or default)
  - [ ] Observability metrics are correct: layers.count, tokens.total, compressed flag
  - [ ] Fail-open verified: simulated layer failure does not abort execution

- [ ] **Audit closure:**
  - [ ] Issue #39 closed
  - [ ] Audit finding CTX-01 marked "RESOLVED"
  - [ ] Code review passed (founder + 1 peer)

---

## §10. References

- **Audit:** `docs/audits/runtime-gap-audit-2026-06-02.md` § F0 (achado de primeira ordem), § CTX-01
- **Issue:** bernardTavares/bevox-harness#39
- **Builder code:** `src/context/context-builder.ts`, `src/context/types.ts`
- **Layers:** `src/context/layers/{base-config,memory,calendar,history,rules}.layer.ts`
- **Execution handler:** `src/runtime/execution-handler.ts` (lines ~790–795 ReAct, ~207–245 Model-C, ~1100–1150 resumption)
- **SDR composition:** `src/sdr/compose.ts` (composeSystemPrompt)
- **Related specs:** 
  - `2026-05-16-sdr-fase-c-correlation-bridge-design.md` (Modelo C justification + architecture)
  - `2026-05-16-sdr-intelligence-module-design.md` (context layers design origin, §5.3)
- **Related ADRs:** ADR-018 (execution modes), ADR-007 (context), ADR-006 (autonomy)
- **Prior builder PRs:** (none — first integration attempt)
