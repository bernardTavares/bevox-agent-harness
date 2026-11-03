# Context Tokenizer Accuracy (CTX-04) & Convergent Budget Compression (CTX-05) — Design

> **Spec ID:** `2026-06-03-context-tokenizer-budget-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Opus 4.8) — AI Engineer. Grounded em leitura direta de `src/context/{tokenizer,budget-enforcer,context-builder}.ts`, `src/context/layers/memory.layer.ts`, `src/integration/llm/usage-decorator.ts` e `src/runtime/execution-handler.ts` (linhas citadas em §10).
> **Escopo:** bevox-harness audit findings CTX-04 (tokenizer heurístico inexato) + CTX-05 (compressão de budget single-pass não-convergente). Seam compartilhado por `main` e PR #61.
> **Estimate:** ~6–8h (3 phases)
> **Issue:** bernardTavares/bevox-harness#62 (a abrir — track CTX-04/CTX-05)

> **⚠️ Nota de compatibilidade com PR #61.** Esta entrega **branca de `main`** (não assume #61
> merged). #61 (branch `ctx-builder`) reescreve `ContextBuilder.build()` para
> `Promise.allSettled` + timeout por layer e introduz um `foldContext(...,{withMarker:true})`
> que insere o `COMPRESSIBLE_MARKER` entre head (BaseConfig+Rules+doctrine) e tail
> (Memory+History). #61 **não toca** `tokenizer.ts` nem `budget-enforcer.ts` e **não** torna a
> compressão convergente. Como #61 seta `agentConfig.maxContextTokens: undefined` no
> `buildContextInput`, o `compress()` interno do builder **nunca roda em prod** — o
> `enforceBudget` (CTX-02, `execution-handler.ts:1312`) é o **único gate vivo** de budget, e
> **só no caminho ReAct** (`handleExecution`); o Model-C (`_dispatchModelCImpl`, `:189-473`)
> chama `runSurfaceAgentLoop` **sem gate** (verificado: 0 `enforceBudget` no range — §8 risco 8).
> Logo o fix CTX-04/CTX-05 pertence a `tokenizer.ts` + `budget-enforcer.ts` —
> exatamente os módulos que #61 deixa intactos — e o fold marker-aware de #61 herda contagem
> exata + compressão convergente **sem conflito de merge**. Único símbolo compartilhado:
> `COMPRESSIBLE_MARKER` (importado, **não** redefinido). Ver §8 risco "PR #61 coupling".

## §1. Context

O harness monta, por execução, um `systemPrompt` (doctrine + SDR composition) e uma lista de
`permittedTools`, e antes de chamar o LLM passa o par por um **gate de budget de tokens**
(`enforceBudget`, wired em `execution-handler.ts:1312`, CTX-02 POC). Esse gate decide se o
prompt cabe no orçamento (`agent_config.max_context_tokens` → `DEFAULT_GLOBAL_MAX_TOKENS`
= 8000) e, se não couber, trunca a porção compressível.

Toda a aritmética de budget depende de **uma única** função de contagem:
`estimateTokens(text)` em `src/context/tokenizer.ts:16-22`, que retorna
`Math.ceil(words * 1.3)` com `words = text.trim().split(/\s+/).filter(Boolean).length`. O
comentário de cabeçalho (`tokenizer.ts:1-9`) justifica o multiplicador 1.3 como aproximação do
`cl100k_base` "accurate enough for context budget enforcement".

Essa função é consumida pelas 5 layers
(`base-config.layer.ts:14`, `rules.layer.ts:35`, `calendar.layer.ts:102`,
`memory.layer.ts:137,178`, `history.layer.ts:76`), pelo builder (`context-builder.ts:60` —
nota: `:71` apenas **soma** `tokenEstimate` pré-computados, não chama `estimateTokens`) e pelo
gate de runtime (`budget-enforcer.ts:123` via `estimateToolTokens`, `:161,189,217,227,235`). A
assinatura síncrona `estimateTokens(text: string): number` é o **seam universal** (drop-in: o
swap BPE não muda nenhum desses call sites).

Sinal de calibração já existe mas está **ocioso**: `LLMResponse.usage = { input_tokens,
output_tokens, total_tokens }` (`llm-gateway.ts:50-54`) carrega contagens reais do provider, e
`UsageDecorator` (`usage-decorator.ts:37-50`) já intercepta todo `complete()` e dispara
`onUsage(usage, meta)` — wired em `execution-handler.ts:910-918` (acumula
`usage.input_tokens` em `usageAccumulator.promptTokens`). **Nenhum código hoje compara o
estimado contra `usage.input_tokens`.**

Dependências (`package.json`): **nenhum tokenizer BPE presente** (sem `tiktoken`,
`js-tiktoken`, `gpt-tokenizer`, sem SDK OpenAI/Anthropic — os adapters são `fetch`
hand-rolled).

## §2. Problem statement

**CTX-04 — A contagem de tokens está sistematicamente errada para o tráfego real do harness.**
`words × 1.3` **subconta**:
- **PT-BR** (idioma primário do produto): palavras acentuadas/aglutinadas tokenizam acima de
  1.3 tokens/palavra no `cl100k_base`.
- **Schemas JSON de tools**: `estimateToolTokens` (`budget-enforcer.ts:113-124`)
  `JSON.stringify`-a os `parameters` e depois faz word-split — `{"type":"object"}` conta como
  ~1 "palavra" mas são muitos tokens BPE (pontuação densa). As tools normalmente **dominam** o
  orçamento.
- **Code blocks e emoji**: 1 "palavra"/emoji pode virar 3-5 tokens.

Consequência operacional: o gate vivo em `execution-handler.ts:1312` **acredita que um prompt
cabe quando não cabe** → risco de erro 400 context-overflow do provider ou truncamento
silencioso — exatamente a superfície que o gate foi adicionado para proteger. E **não há loop
de feedback de acurácia** apesar de `usage.input_tokens` estar disponível.

**CTX-05 — Ambos os compressores são single-pass e não-convergentes.** Há **dois** sites de
compressão, ambos cortando uma vez e retornando sem re-verificar:

1. **`ContextBuilder.compress()`** (`context-builder.ts:32-64`) — itera blocks do menor para o
   maior prioridade; para cada block compressível faz **um** corte proporcional
   `keepLines = max(3, floor(lines.length * ratio))` onde `ratio = compressibleBudget /
   compressibleTotal`. Como o `ratio` é calculado contra o **total** compressível mas aplicado
   **por block**, e o `max(3,...)` põe um piso em cada block, um único pass pode deixar
   `total > limit` (sub-compressão). **NOTA: este site não roda em prod** sob #61
   (`maxContextTokens: undefined` bypassa o `compress()`); fica como segundo-site conhecido,
   **fora de escopo** (§3 non-goals), mas registrado.

2. **`enforceBudget` / `truncatePromptToBudget`** (`budget-enforcer.ts:158-245`) — o gate
   **vivo**. Estima `promptTokens + Σ toolTokens`; se acima do budget computa
   `availablePromptBudget = budget - toolTokens`; se `< MIN_PROMPT_TOKENS (200)` emite warning
   não-fatal e **embarca o prompt cheio** (`:176-185`); senão chama `truncatePromptToBudget`
   **uma vez** (`:212-245`). O helper splita no `COMPRESSIBLE_MARKER` (`:140`): head sempre
   preservado, tail cortado por `keep = max(1, floor(tailLines.length * ratio))` num **único
   pass sem verificação pós-corte**. `finalTokens` é recomputado (`:189`) e retornado **mas
   nunca reconciliado contra o budget**.

Por que single-pass falha: line-proportional ≠ token-proportional (variância de comprimento de
linha em markdown), e os pisos `max(1,...)`/`max(3,...)` mantêm mais linhas do que o `ratio`
implica. `EnforcedContext` **não tem invariante** `finalTokens <= budgetTokens`, e o caller
(`execution-handler.ts:1326-1353`) **não asserta** uma. O fallback marker-absent (`:215-223`)
preserva `max(3,...)` linhas iniciais que sozinhas podem exceder o budget. Resultado: um prompt
pode **embarcar acima do budget após "compressão"**, derrotando o gate.

CTX-04 **agrava** CTX-05: contagem inexata significa que mesmo um corte convergente convergiria
para o número errado. Os dois fixes são complementares e tocam o mesmo seam.

## §3. Goals & non-goals

**Goals:**

- **CTX-04:** Substituir a heurística por contagem **model-aware** acurada, **preservando a
  assinatura síncrona** `estimateTokens(text: string): number` (zero ripple nos ~7 call sites
  diretos + `estimateToolTokens` + o fold de #61). Decisão de design em §4.1 (3 opções) — recomendada: **BPE real via
  `js-tiktoken` (pure-JS) com fallback fail-open para a heurística**.
- **CTX-04 (telemetria):** Tornar a acurácia **observável** — emitir a razão
  `actual_input_tokens / estimated_prompt_tokens` como atributo OTel, reusando o seam
  `UsageDecorator.onUsage` (`usage-decorator.ts:41`) já wired em `execution-handler.ts:914`.
- **CTX-05:** Tornar `truncatePromptToBudget` **iterativo/convergente** (corta → re-mede →
  repete, **≤6 iterações** com piso head-only) até `finalTokens <= budget`, e adicionar a
  **invariante de pós-condição** `finalTokens <= budgetTokens` (quando `wasCompressed &&
  availablePromptBudget >= MIN_PROMPT_TOKENS`) ao `EnforcedContext`, assertada em teste.
- Preservar **intacto**: a semântica de `COMPRESSIBLE_MARKER` (head sempre preservado), o
  comportamento warning-not-abort de `MIN_PROMPT_TOKENS` (`:176-185`), e a pureza síncrona do
  `enforceBudget` (sem I/O, sem logger).
- Manter o **hot path rápido**: encoder BPE como **singleton lazy module-level** (decode do
  vocab uma vez por processo worker, reuso), loop CTX-05 bounded.
- Testes novos **somente em `tests/**`** (vitest roda só `tests/**/*.test.ts`; a cópia
  co-located `src/context/tokenizer.test.ts` é **morta** — não estender).

**Non-goals:**

- **NÃO** mudar a assinatura de `estimateTokens` (continua `(text: string) => number`,
  síncrona).
- **NÃO** tornar `ContextBuilder.compress()` (`context-builder.ts:32-64`) convergente — é
  single-pass também, mas **não roda em prod** sob #61 (bypassed por `maxContextTokens:
  undefined`). Registrado como segundo-site conhecido (§8); só entra em escopo se #61 mudar essa
  wiring.
- **NÃO** trimar tool definitions (continuam contadas mas nunca cortadas, como o POC CTX-02).
- **NÃO** adicionar encoder por-provider (Gemini/Anthropic). `o200k_base` (vocab do gpt-4o-mini,
  o `DEFAULT_LLM_MODEL`) cobre OpenAI (provider primário, `harness-llm.md`); não-OpenAI é
  aproximação conservadora aceitável. Encoder per-provider é follow-up (§8, open question 3).
- **NÃO** tocar `migrations/`, Postgres/pgvector ou Redis. CTX-04/CTX-05 são puros/síncronos;
  **sem testes de integração gated** necessários (pgvector é território CTX-03, fora de escopo).
- **NÃO** reservar headroom para user message / output tokens no gate (o user turn é appendado
  **após** o gate em `execution-handler.ts:1356-1360`). É finding separado — flagged em §8
  open question 2.
- **NÃO** mexer no `bootstrap` — o encoder carrega lazy **fora** do bootstrap (não pode virar
  novo `process.exit(1)`).

## §4. Architecture proposal

### 4.1 CTX-04 — Decisão: opções de tokenizer

| Opção | Descrição | Prós | Contras |
|------|-----------|------|---------|
| **A — BPE real via `js-tiktoken/lite`** (pure-JS) | Encoder `o200k_base` lazy module-level (subpath lite + 1 rank) por trás da assinatura existente. | Acurácia real para OpenAI primário; pure-JS (sem WASM cold-start, ao contrário de `@dqbd/tiktoken`); drop-in (assinatura intacta → callers + fold de #61 não mudam). Elimina undercount PT-BR/JSON/emoji na origem. | Nova dep runtime. ⚠️ Tem de usar `js-tiktoken/lite` + `import()` de UM rank: o entry principal embute 7 vocabs (~5.4 MB) no graph. Carga assíncrona → janela de warm-up onde o fallback heurístico ainda responde. Encoder é per-vocab → Gemini/Anthropic divergem (aceitável: OpenAI primário). Quebra o pin de 1.3 em `tokenizer.test.ts:39-43`. |
| **B — Heurística recalibrada + multiplicador script-aware** | Bump do multiplicador base + termo de correção (chars-sem-espaço p/ acentos, densidade-JSON em `estimateToolTokens`). | Zero deps, zero cold-start, minimal-change. Mantém contrato síncrono puro. | Continua estimativa — variância alta p/ emoji/code; tuning das constantes é chute sem corpus; **re-pina um número mágico que a próxima auditoria re-flagga**. |
| **C — Heurística agora + loop de calibração via `UsageDecorator`** (telemetry-first) | Emitir razão `actual/estimated` como atributo OTel; medir o erro real **antes** de escolher multiplicador/BPE. | Sem dep de tokenizer. Mede o erro real; mudança hot-path mais barata; data-driven. **Empilhável com A ou B.** | Não corrige a inexatidão **agora**, só observa; precisa threadar o estimado até o decorator (hoje o decorator não vê o estimado pré-call). |

**Recomendação (founder decide): Opção A + Opção C empilhadas.** Justificativa grounded no
código:

1. OpenAI é o provider primário (`harness-llm.md`); o gate `execution-handler.ts:1312` (caminho
   ReAct) conta `systemPrompt + tools` (JSON-dense, onde a heurística mais erra). ⚠️ **Nota: o
   gate NÃO é o único caminho** — `_dispatchModelCImpl` (`:189-473`) chama `runSurfaceAgentLoop`
   **sem `enforceBudget`** (confirmado: 0 hits de `enforceBudget` em `:189-473`). No Model-C, um
   undercount causa overflow de provider **sem gate algum** — CTX-04 ajuda menos lá até o gate ser
   estendido (§8 risco 8). Isso não invalida a recomendação, mas relativiza o "único lugar".
2. A assinatura `estimateTokens(text): number` já é o seam universal — um swap BPE é o
   **maior ganho de acurácia com menor blast-radius**.
3. `js-tiktoken/lite` (pure-JS) **não** `@dqbd/tiktoken` (WASM): evita cold-start de WASM num
   worker BullMQ long-running (2 réplicas, `CLAUDE.md`). **Mas** ver §8 risco 1: usar o subpath
   `lite` + 1 rank, não o entry default (que embute ~5.4 MB de vocabs).
3b. **Contra-argumento adversarial (founder pondere):** se a meta imediata fosse só *não estourar
   o provider*, calibrar a heurística contra `usage.input_tokens` (Opção C sozinha, ~1.5h, zero
   dep) responde "por quanto erramos" antes de pagar ~2.3 MB de rank + janela de warm-up. A
   resposta pró-BPE: o undercount é **estrutural** (JSON denso/PT-BR), não um offset escalar — um
   multiplicador único não corrige tool-schemas e prosa PT-BR ao mesmo tempo. Logo BPE + telemetria
   (A+C) > recalibrar (B). Mas se o erro medido por C ficar <~10% e estável, B pode bastar e
   dispensa a dep — **decisão deferida p/ os dados de C** (§8 open question 1).
4. **Fail-open**: se o encoder não carregar, cai na heurística `words×1.3` existente —
   preserva o ethos fail-open e evita virar dependência de bootstrap.
5. Opção C (telemetria) em paralelo torna a acurácia **observável em prod** e detecta quando o
   fallback está ativo, sem custo de remédio. **Opção B é rejeitada como primária** (re-pina
   número mágico), mas a ideia de densidade-JSON dela é refinamento válido do **path de
   fallback**.

**4.1.1 `tokenizer.ts` — encoder lazy singleton + fallback**

```typescript
/**
 * Token count — model-aware BPE (o200k_base) com fallback heurístico fail-open.
 *
 * CTX-04: substitui a heurística words×1.3 (que subcontava PT-BR/JSON/emoji)
 * por um encoder BPE real, mantendo a assinatura síncrona `estimateTokens(text)`
 * intacta (6 callers diretos + estimateToolTokens + o fold marker-aware de PR #61
 * não mudam).
 *
 * IMPORTANTE — usar o subpath `js-tiktoken/lite` + UM rank file, NÃO o entry
 * principal `"js-tiktoken"`. O entry principal (`dist/index.js`, ~5.4 MB)
 * importa ESTATICAMENTE os 7 rank tables (cl100k 1.1 MB + o200k 2.3 MB + 5
 * outros), pagos no momento do `import` — o guard lazy NÃO evita esse custo.
 * `js-tiktoken/lite` não embute rank nenhum; o rank único é carregado por
 * `import()` dinâmico DENTRO de `getEncoder()`, tornando o lazy real (só 1 vocab,
 * só no 1º call). Ver §8 risco 1/2.
 *
 * O encoder é um SINGLETON lazy module-level: o rank é importado + o BPE map
 * construído UMA vez por processo worker (não por execução nem por call). Falha
 * de carga → fallback para a heurística legada (fail-open; NÃO é falha de
 * bootstrap). Como o `import()` é assíncrono mas `estimateTokens` é síncrona, a
 * carga é disparada fire-and-forget no 1º call e a heurística serve até o
 * encoder ficar pronto (warm-up de poucos calls; ver §8 risco 1).
 */
import { Tiktoken, type TiktokenBPE } from "js-tiktoken/lite";

let encoder: Tiktoken | null = null;
let encoderLoadFailed = false;
let encoderLoading = false;

/**
 * Carrega/reusa o encoder o200k_base via subpath lite + UM rank.
 * Retorna null enquanto carrega (1ºs calls usam heurística) e se a carga falhou.
 * NÃO bloqueia: dispara o `import()` do rank fire-and-forget e cacheia.
 */
function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (encoderLoadFailed || encoderLoading) return null;
  encoderLoading = true;
  // `import()` dinâmico do rank ÚNICO — não puxa os outros 6 vocabs.
  import("js-tiktoken/ranks/o200k_base")
    .then((mod) => {
      encoder = new Tiktoken(mod.default as TiktokenBPE);
    })
    .catch(() => {
      encoderLoadFailed = true; // não re-tenta a cada call
    })
    .finally(() => {
      encoderLoading = false;
    });
  return null; // 1º call (e os que ocorrem durante a carga) caem na heurística
}

/** Fallback legado: words×1.3 (CTX-04 pré-fix). Conservador p/ EN/PT. */
function heuristicTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Estima o número de tokens em uma string. >= 0.
 * Usa BPE o200k_base (gpt-4o/gpt-4o-mini, OpenAI primário) quando o encoder já
 * carregou; cai na heurística enquanto carrega ou se a carga falhar.
 *
 * ⚠️ Determinismo: dentro de um mesmo TICK síncrono é determinística (o encoder
 * só troca de estado num microtask). Mas ACROSS a janela de warm-up o MESMO
 * input pode mudar de valor (heurística → BPE) na 1ª vez que o encoder fica
 * pronto. Não é problema p/ o gate (cada execução conta uma vez), mas testes que
 * assertam determinismo absoluto precisam forçar um estado (encoder pronto OU
 * fallback) antes — ver §5 Phase 1 e §8 risco 1.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const enc = getEncoder();
  if (!enc) return heuristicTokens(text);
  try {
    return enc.encode(text).length;
  } catch {
    return heuristicTokens(text); // defensivo por-call: nunca quebra o caller
  }
}

/** Exposto p/ teste: true quando a carga do encoder falhou em definitivo. */
export function isUsingFallbackTokenizer(): boolean {
  return encoderLoadFailed;
}
```

**Pontos críticos:**
- **Subpath `js-tiktoken/lite` + UM rank**, NUNCA o entry `"js-tiktoken"` — senão os 7
  rank tables (~5.4 MB) entram no module graph no `import`, anulando o lazy. (Confirmado
  inspecionando `node_modules`/o tarball: `dist/index.js` importa os 7 ranks estaticamente.)
- **`getEncoder()` é singleton**: NUNCA `new Tiktoken(...)` por call (seria leak + latência por
  execução). Build do BPE map é one-time por processo, no microtask do `import()`.
- **Sem mudança de assinatura**: os 6 callers diretos + `estimateToolTokens` (incl.
  `memory.layer.ts:137,178` e o fold de #61) chamam exatamente o mesmo `estimateTokens(text)`.
- **`js-tiktoken` é pure-JS** (não WASM) — sem cold-start de WASM no worker; o único custo é
  parsear o rank base64 do o200k (~2.3 MB) num microtask, amortizado no worker long-running.

**4.1.2 Calibração (Opção C) — atributo OTel via `UsageDecorator`**

O seam `onUsage` já existe (`usage-decorator.ts:41`, wired `execution-handler.ts:914`). Hoje o
callback **não vê** o estimado pré-call. Mínima mudança: o handler já tem `enforced.finalTokens`
(estimado do prompt, `execution-handler.ts:1328`) em escopo; basta capturá-lo e, no `onUsage`,
comparar com `usage.input_tokens`:

```typescript
// execution-handler.ts — após o gate (~:1353), o estimado do prompt está em
// `enforced.finalTokens`. Capturar p/ comparação na 1ª resposta do LLM:
const estimatedPromptTokens = enforced.finalTokens;

// no onUsage existente (:914) — adicionar a razão de calibração como span attr,
// best-effort (o callback já engole throws):
onUsage: (usage) => {
  usageAccumulator.promptTokens += usage.input_tokens ?? 0;
  usageAccumulator.completionTokens += usage.output_tokens ?? 0;
  if (estimatedPromptTokens > 0 && (usage.input_tokens ?? 0) > 0) {
    rootSpan.setAttribute(
      "context.token_estimate_ratio",
      (usage.input_tokens ?? 0) / estimatedPromptTokens,
    );
    rootSpan.setAttribute("context.tokenizer_fallback", isUsingFallbackTokenizer());
  }
},
```

> **Nota:** o `onUsage` é definido em `execution-handler.ts:911-918`, **antes** do gate em
> `:1312`. A captura de `estimatedPromptTokens` precisa estar em escopo do closure — opções: (a)
> declarar `let estimatedPromptTokens = 0;` antes do `createLLMGateway` e atribuir após o gate
> (closure captura por referência); ou (b) usar um pequeno objeto mutável como o
> `usageAccumulator` já faz. Preferir (a) pela simplicidade. **Telemetria-only nesta entrega**
> (não auto-tuna multiplicador — ver §8 open question 1). A 1ª resposta do LLM é a única com
> `input_tokens` correspondente ao prompt do gate (turns subsequentes acumulam histórico); por
> isso a razão é informativa, não exata, após o turn 1 — flagged em §8.

### 4.2 CTX-05 — `truncatePromptToBudget` iterativo/convergente

Envolve o corte único num loop bounded com invariante de pós-condição. Preserva head sempre,
piso head-only como caso terminal.

**Antes (`budget-enforcer.ts:212-245`, single-pass — resumido; os early-returns
`promptTokens <= budget`/`tailTokens <= tailBudget` do código real foram omitidos por brevidade
— o bug é o **corte único sem re-medida**, não a ausência de early-return):**
```typescript
function truncatePromptToBudget(prompt: string, budget: number): string {
  const markerIdx = prompt.indexOf(COMPRESSIBLE_MARKER);
  if (markerIdx === -1) {
    const ratio = budget / estimateTokens(prompt);
    const lines = prompt.split("\n");
    const keep = Math.max(3, Math.floor(lines.length * ratio));   // UM corte
    return lines.slice(0, keep).join("\n");
  }
  const head = prompt.slice(0, markerIdx);
  const tail = prompt.slice(markerIdx + COMPRESSIBLE_MARKER.length);
  const headTokens = estimateTokens(head);
  if (headTokens >= budget) return head;                          // piso head-only
  const ratio = (budget - headTokens) / estimateTokens(tail);
  const tailLines = tail.split("\n");
  const keep = Math.max(1, Math.floor(tailLines.length * ratio)); // UM corte
  return `${head}${COMPRESSIBLE_MARKER}${tailLines.slice(0, keep).join("\n")}`;
}
```

**Depois (convergente, ≤6 iter, head-preserving):**
```typescript
/** Máx. de iterações de re-medida. Bound rígido p/ custo BPE e p/ garantir terminação. */
const MAX_TRUNCATE_ITERATIONS = 6;

/**
 * Trunca o tail compressível convergindo para `finalTokens <= budget`.
 *
 * CTX-05: substitui o corte único por um loop bounded — corta linhas do tail,
 * RE-MEDE, e repete (encolhendo o keep) até caber OU restar o piso. Cada
 * iteração reduz `keep` por um shrink factor multiplicativo `keep * (budget/tokens)`
 * (iteração de ponto-fixo sobre o ratio sobrante, NÃO binary search). `keep`
 * decresce ESTRITAMENTE a cada passo (`floor(keep*r)` com `r<1` e `keep` inteiro
 * ⇒ `< keep`), então o loop termina mesmo sem o bound; o `≤6` é teto duro de
 * custo BPE (≤6 re-encodes do tail).
 *
 * Invariantes preservadas: head SEMPRE intacto (branch marker); o caso terminal
 * é um PISO — head-only (marker, headTokens >= budget) ou 3 linhas (no-marker).
 * Pós-condição: estimateTokens(result) <= budget, EXCETO quando o piso já
 * estoura (head sozinho, ou as 3 linhas-piso) — nesse caso retorna o piso e o
 * caller observa `withinBudget === false`. NÃO é garantido `result === head` no
 * branch no-marker (não há head ali). Ver §4.2.1 e §8 risco 9.
 */
function truncatePromptToBudget(prompt: string, budget: number): string {
  const markerIdx = prompt.indexOf(COMPRESSIBLE_MARKER);

  // --- Marker ausente: corte convergente sobre o prompt inteiro, piso 3 linhas.
  if (markerIdx === -1) {
    const lines = prompt.split("\n");
    if (estimateTokens(prompt) <= budget) return prompt;
    let keep = Math.max(3, Math.floor(lines.length * (budget / estimateTokens(prompt))));
    for (let i = 0; i < MAX_TRUNCATE_ITERATIONS; i++) {
      const candidate = lines.slice(0, keep).join("\n");
      const tokens = estimateTokens(candidate);
      if (tokens <= budget || keep <= 3) return candidate;       // cabe OU piso
      // re-mede e encolhe proporcional ao overshoot (convergência):
      keep = Math.max(3, Math.floor(keep * (budget / tokens)));
    }
    return lines.slice(0, Math.max(3, keep)).join("\n");          // bound terminal
  }

  // --- Marker presente: head intacto, tail convergente.
  const head = prompt.slice(0, markerIdx);
  const tail = prompt.slice(markerIdx + COMPRESSIBLE_MARKER.length);
  const headTokens = estimateTokens(head);
  if (headTokens >= budget) return head;                          // piso head-only

  const tailBudget = budget - headTokens;
  const tailLines = tail.split("\n");
  if (estimateTokens(tail) <= tailBudget) return prompt;

  let keep = Math.max(1, Math.floor(tailLines.length * (tailBudget / estimateTokens(tail))));
  let truncatedTail = tailLines.slice(0, keep).join("\n");
  for (let i = 0; i < MAX_TRUNCATE_ITERATIONS; i++) {
    const tailTokens = estimateTokens(truncatedTail);
    if (tailTokens <= tailBudget || keep <= 1) break;             // cabe OU piso (1 linha)
    keep = Math.max(1, Math.floor(keep * (tailBudget / tailTokens)));
    truncatedTail = tailLines.slice(0, keep).join("\n");
  }
  return `${head}${COMPRESSIBLE_MARKER}${truncatedTail}`;
}
```

**4.2.1 `EnforcedContext` — invariante de pós-condição**

Adicionar campo booleano explícito + checagem no `enforceBudget` (sem abortar — só registra),
para que testes assertem a invariante e o caller possa logar regressões:

```typescript
export interface EnforcedContext {
  systemPrompt: string;
  originalTokens: number;
  finalTokens: number;
  budgetTokens: number;
  wasCompressed: boolean;
  /**
   * CTX-05: true quando finalTokens <= budgetTokens após compressão. False nos
   * casos terminais de PISO onde o conteúdo mínimo já estoura o budget:
   *   (a) marker presente: head sozinho >= budget → retorna head;
   *   (b) marker ausente: as 3 linhas-piso já excedem o budget.
   * Em ambos o gate fez o melhor possível e o caller deve logar/observar.
   */
  withinBudget: boolean;
  warning?: string;
}
```

No `enforceBudget` (`:188-198`), após o truncate convergente:
```typescript
  const truncated = truncatePromptToBudget(input.systemPrompt, availablePromptBudget);
  const finalPromptTokens = estimateTokens(truncated);
  const finalTokens = finalPromptTokens + toolTokens;
  return {
    systemPrompt: truncated,
    originalTokens,
    finalTokens,
    budgetTokens,
    wasCompressed: true,
    withinBudget: finalTokens <= budgetTokens,   // CTX-05 invariante observável
  };
}
```

`enforceBudget` tem **3 return paths** (confirmado: `:165` under-budget, `:177` warning, `:192`
compressed — 3 `return {` no range `:158-199`). Os **2** não-compressed setam `withinBudget`
coerente: under-budget → `true` (`originalTokens <= budgetTokens`); warning-not-abort → `false`
(embarca prompt cheio acima do budget, é o comportamento esperado por PRD). O caller em
`execution-handler.ts:1326-1329` ganha uma linha opcional:
`rootSpan.setAttribute("context.within_budget", enforced.withinBudget)`.

> **`COMPRESSIBLE_MARKER` continua importado, não redefinido** — compatível com o fold de #61.

## §5. Implementation plan

### Phase 1 — Tokenizer BPE + fallback (CTX-04) (~2.5h)

**Files:**
- `package.json` — adicionar dep `js-tiktoken` (pure-JS, v1.0.21 verificado no registry). Rodar
  `npm install` e commitar lockfile. **Importar via subpath `js-tiktoken/lite` +
  `js-tiktoken/ranks/o200k_base`**, NÃO o entry default (§4.1.1, §8 risco 1).
- `src/context/tokenizer.ts` — encoder lazy singleton (`getEncoder` com `import()` dinâmico do
  rank único, fire-and-forget), `heuristicTokens` fallback, `estimateTokens` BPE-backed,
  `isUsingFallbackTokenizer()` export (§4.1.1). Manter `estimateTokens(text: string): number`
  síncrona.

**Testes (`tests/unit/context/tokenizer.test.ts`):**
- **REMOVER** o pin `words×1.3` em `:39-43` ("10 words → 13"); substituir por golden BPE
  counts para uma amostra fixa EN + PT-BR (acentuada) + emoji + JSON, com a contagem
  `o200k_base` hardcoded (computar uma vez com o encoder pronto e pinnar). **`await` a carga do
  encoder** (ex.: pequeno helper que faz `await getEncoderReady()` ou faz um warm call +
  `await Promise.resolve()` ticks) antes de assertar BPE — senão pega a janela de fallback.
- MANTER os 4 casos genéricos que valem para qualquer tokenizer monotônico/determinístico
  (`:6-37`: empty→0, whitespace→0, positivo-int, longer>shorter, multiline). O caso
  "determinístico" (`:28-31`) continua verde **dentro de um tick** (sem `await` entre as 2
  chamadas), mas documentar que o determinismo é por-tick (§4.1.1 nota de warm-up).
- ADICIONAR: forçar `encoderLoadFailed` (mock do `import("js-tiktoken/ranks/o200k_base")` p/
  rejeitar) e assertar que `estimateTokens` retorna int positivo via fallback +
  `isUsingFallbackTokenizer()===true`.

**Result:** contagem acurada para OpenAI; subcontagem PT-BR/JSON/emoji eliminada na origem;
fail-open preservado.

> **NÃO** estender `src/context/tokenizer.test.ts` (co-located, morto — vitest `include:
> ['tests/**/*.test.ts']`, confirmado em `vitest.config.ts`). Opcionalmente deletar como cleanup
> (padrão audit D-07), mas fora de escopo se preferir minimal.

### Phase 2 — Compressão convergente + invariante (CTX-05) (~2.5h)

**Files:**
- `src/context/budget-enforcer.ts` — `MAX_TRUNCATE_ITERATIONS = 6`; reescrever
  `truncatePromptToBudget` (`:212-245`) com loop bounded convergente (§4.2); adicionar
  `withinBudget` a `EnforcedContext` (`:80-101`); setá-lo nos **3 return paths** de
  `enforceBudget` (`:165` under, `:177` warning, `:192` compressed).
- `src/runtime/execution-handler.ts:1329` — (opcional) `rootSpan.setAttribute(
  "context.within_budget", enforced.withinBudget)` ao lado dos attrs CTX-02 existentes.

**Testes (`tests/unit/context/budget-enforcer.test.ts`):**
- MANTER os **9 casos existentes** verdes — incluindo marker-preservation (`:109-127`) e os dois
  warning-not-abort (`:131-161`); o teste under-budget (`:65-87`) e a regressão dependem de
  `withinBudget` ser coerente.
- ADICIONAR a **invariante de convergência** (formulação CORRETA — ver §8 risco 9): assertar
  `result.withinBudget === (result.finalTokens <= result.budgetTokens)` **sempre** (definição do
  campo). E para prompts grandes **com conteúdo compressível suficiente** (cada linha << budget,
  de modo que o piso de 3 linhas / o head caibam), assertar `result.withinBudget === true` **e**
  `result.finalTokens <= result.budgetTokens`. ⚠️ NÃO assertar `finalTokens <= budget` para todo
  caso `wasCompressed` — o piso (3 linhas no-marker / head-only marker) pode legitimamente
  estourar e nesse caso `withinBudget === false` é o esperado (não uma regressão).
- ADICIONAR regressão do bug: construir um prompt cujo **single-pass deixaria
  `finalTokens > budget`** (line-proportional ≠ token-proportional, com variância de comprimento
  de linha, MAS linhas individualmente pequenas o bastante p/ caber abaixo do budget) e provar
  que o loop novo converge para `<= budget` (`withinBudget === true`).
- ADICIONAR terminação: input patológico (toda linha individual > budget) → retorna head
  (marker) / 3 linhas (no-marker) sem spin, `withinBudget === false`, ≤6 iterações; provar que o
  loop respeita `MAX_TRUNCATE_ITERATIONS` (ex.: spy em `estimateTokens` ou contador injetável).

> **CUIDADO** com `tests/unit/context/budget-enforcer.test.ts:20-30`: o comentário e os helpers
> `makeWords` assumem `ceil(wordCount * 1.3)` para sintetizar inputs por contagem de palavras.
> Com BPE (Phase 1) esses números mudam. Os testes que **derivam** o esperado de
> `estimateTokens(...)` (ex.: `:42-46`, `:167`) continuam corretos (são auto-referentes). Os que
> **dependem de relações** (budget vs MIN_PROMPT_TOKENS, "60 linhas excedem 400") podem precisar
> de ajuste de constantes para manter a relação sob BPE — reverificar ao rodar Phase 1+2 juntas.
> Atualizar o comentário `:13-18` para refletir BPE.

### Phase 3 — Calibração telemetria (CTX-04 Opção C) (~1.5h)

**Files:**
- `src/runtime/execution-handler.ts` — `let estimatedPromptTokens = 0;` antes de
  `createLLMGateway` (~`:910`); atribuir `estimatedPromptTokens = enforced.finalTokens` após o
  gate (~`:1353`); no `onUsage` (`:914-918`) emitir `context.token_estimate_ratio` +
  `context.tokenizer_fallback` no `rootSpan` (§4.1.2).
- (Sem mudança em `usage-decorator.ts` — o `onUsage` callback já passa `usage`.)

**Testes (`tests/unit/context/`):**
- `tests/unit/context/tokenizer-calibration.test.ts` (novo) — teste unitário do cálculo da razão
  estimate-vs-actual: dado um `usage.input_tokens` fixo e um estimado fixo, a razão emitida =
  `actual/estimated`. Pode testar uma função pura extraída (`computeCalibrationRatio(estimated,
  actual)`) em vez de mockar o handler inteiro (preferir extrair a função pura p/ testabilidade).

**Result:** acurácia observável em prod; fallback detectável; sem mudar o remédio.

## §6. Testing strategy

Todos os testes **novos** sob `tests/**` (vitest roda só `tests/**/*.test.ts`; a cópia
co-located `src/context/tokenizer.test.ts` é morta — **não** estender). Rodar
`npm run test -- tests/unit/context` no loop rápido; `npm run test` completo antes do Code
Reviewer.

### Unit (o grosso — sem gating, rápido)
- **`tokenizer.test.ts`**: golden BPE counts `o200k_base` (EN+PT-BR+emoji+JSON hardcoded, com o
  encoder pronto — `await` da carga antes de assertar); monotonicidade + determinismo-por-tick (4
  casos genéricos mantidos); fallback retorna int positivo quando o `import()` do rank é mockado
  p/ rejeitar + `isUsingFallbackTokenizer()===true`.
- **`budget-enforcer.test.ts`**: tautologia `withinBudget === (finalTokens <= budgetTokens)`
  sempre; convergência → `withinBudget===true` p/ prompt compressível (linhas << budget); NÃO
  assertar `finalTokens <= budget` no caso de piso (ver §5 Phase 2 e §8 risco 9); regressão
  provando que o old single-pass deixava `finalTokens > budget` e o loop conserta; terminação em
  input patológico (≤6 iter); os 9 casos existentes verdes (marker-preservation `:109-127`,
  warning-not-abort `:131-161` inalterados).
- **`tokenizer-calibration.test.ts`** (novo): `computeCalibrationRatio` puro forwarding
  estimate-vs-actual (inner gateway fake com `usage.input_tokens` fixo).

### Integration (RUN_INTEGRATION-gated)
- **NÃO requerido** para CTX-04/CTX-05 — ambos são puros/síncronos; sem Postgres/pgvector/Redis.
- Só tocar `context-builder.integration.test.ts` existente se quiser verificar contagens
  end-to-end do fold; **gate atrás do guard `RUN_INTEGRATION`** para o run default ficar DB-free.
  **NÃO** puxar pgvector (território CTX-03, fora de escopo).

### Regression
- Os 7 callers de `estimateTokens` continuam compilando (assinatura inalterada).
- `memory.layer.ts:137` (skip de semantic recall com `< tokenBudget - 200`): contagem mais
  acurada (maior) → skip de recall **um pouco mais cedo**. Benigno (mais conservador) — assertar
  que não quebra recall coverage; documentado em §8 p/ não confundir com regressão.

## §7. Migration & rollback

**Ativação gradual:**
1. **Phase 1 (tokenizer BPE):** muda a contagem em todos os 7 callers de uma vez. Efeito
   observável: budgets ficam mais acurados (geralmente **maiores** que a heurística → compressão
   dispara mais cedo, mais conservador). Sem mudança de contrato. **Fail-open**: se a dep
   falhar, cai na heurística (status quo).
2. **Phase 2 (convergência):** muda só o comportamento de truncate dentro do gate vivo. O
   `withinBudget` é aditivo (novo campo). Backend não afetado (gate é interno).
3. **Phase 3 (telemetria):** aditivo — só novos atributos OTel. Sem efeito no caminho do LLM
   (`onUsage` já é best-effort, engole throws).

**Rollback:** cada fase é revertível sem perda de dados.
- Reverter Phase 1 = remover a dep + voltar `tokenizer.ts` à heurística (1 arquivo + lockfile).
- Reverter Phase 2 = voltar `truncatePromptToBudget` ao single-pass + remover `withinBudget`.
- Reverter Phase 3 = remover os 2 `setAttribute` + a captura do estimado.
Nenhum rollback é destrutivo.

**Feature flag (opcional):** `HARNESS_BPE_TOKENIZER_ENABLED` (default `true`); `false` faz
`getEncoder()` retornar `null` imediatamente (sem disparar o `import()` do rank) → path heurístico
puro — útil se o rank causar regressão de latência/memória em prod. Aposentar após calibração
confirmar acurácia.

**Compat com PR #61:** land em branch de `main`; toca só `tokenizer.ts` + `budget-enforcer.ts`
(+ wiring opcional no handler), que #61 **não modifica**. #61 merga limpo em qualquer ordem e
herda contagem acurada + compressão convergente via o fold marker-aware. Único símbolo
compartilhado: `COMPRESSIBLE_MARKER` (importado, não redefinido).

## §8. Risks & open questions

### Risks

1. **HOT-PATH latency + IMPORT cost (verificado no tarball).** `estimateTokens` é chamado
   O(layers + tools) por execução, e o loop CTX-05 chama ≤6× a mais. Com `words×1.3` é trivial;
   com BPE cada call encoda a string inteira — sub-ms após warm-up. **Achado adversarial:** o
   entry default `"js-tiktoken"` (`dist/index.js`, ~5.4 MB) importa os **7 rank tables
   estaticamente** (cl100k 1.1 MB + o200k 2.3 MB + 5 outros), pagos no `import` — o guard lazy do
   `getEncoder()` **não evita** esse custo se importarmos o entry default. Mitigação **obrigatória**:
   `import { Tiktoken } from "js-tiktoken/lite"` (zero ranks embutidos) + `import()` **dinâmico**
   de `js-tiktoken/ranks/o200k_base` dentro de `getEncoder()` → só 1 vocab carrega, e só no 1º
   call. Como `import()` é async e `estimateTokens` é sync, há uma **janela de warm-up** (poucos
   calls) onde o fallback heurístico responde — aceitável (degradação graciosa), mas significa que
   o 1º prompt de cada processo é contado pela heurística. **CONFIRMAR no review:** (a) import via
   `/lite` + 1 rank; (b) nenhum `new Tiktoken(...)` por-call; (c) o `import()` é disparado uma vez
   (guard `encoderLoading`).

2. **COLD-START / bootstrap.** O bootstrap de 7 estágios `exit(1)` em falha; o tokenizer **não
   pode** virar novo ponto de falha. O encoder carrega **lazy fora do bootstrap** (via `import()`
   no 1º `estimateTokens`) e cai na heurística se o rank não resolver (`encoderLoadFailed`) — rank
   ausente/corrompido degrada graciosamente, não aborta o worker. Nota: o `import()` async não
   pode ser `await`-ado dentro do `estimateTokens` síncrono; logo a 1ª contagem **sempre** usa a
   heurística (a promise resolve num microtask posterior). Sem efeito de correção no 1º prompt do
   processo — relevante p/ o worker que processa poucas execuções antes de morrer.

3. **Convergência edge.** Loop CTX-05 em input patológico (todas as linhas > budget) poderia
   spinnar — o bound `≤6 iter` + piso head-only (`headTokens >= budget → return head`,
   `:229-232`) / piso 3-linhas (no-marker) é o caso terminal. `keep` decresce estritamente a cada
   iter (`floor(keep * r)` com `r < 1` e `keep` inteiro ⇒ `< keep`), então mesmo sem o bound o
   loop terminaria; o bound `≤6` é guarda dura adicional + teto de custo BPE. Terminação +
   contagem de iterações assertadas em teste.

4. **PROVIDER mismatch + encoding escolhido.** O `DEFAULT_LLM_MODEL` é `gpt-4o-mini`, cujo vocab é
   `o200k_base` (não `cl100k_base`). **Decisão: usar `o200k_base`** (disponível em
   `js-tiktoken/ranks/o200k_base`). `cl100k_base` seria uma aproximação próxima mas
   desnecessariamente menos exata dado o default. Para Gemini/Anthropic (secundário/pós-V1,
   `harness-llm.md`) o `o200k_base` diverge — aceitável como estimativa conservadora; encoder
   per-provider é follow-up (open question 3).

5. **PR #61 coupling (baixo).** Único símbolo compartilhado é `COMPRESSIBLE_MARKER` (consumido,
   não redefinido). Assunção a declarar: `buildContextInput` de #61 seta `maxContextTokens:
   undefined`, então `ContextBuilder.compress()` (`context-builder.ts:32-64`) **nunca roda em
   prod** — se um futuro change re-habilitar, `compress()` é **também** single-pass e precisaria
   do mesmo tratamento convergente. Registrado como segundo-site conhecido, **fora de escopo**
   salvo #61 mudar essa wiring.

6. **MEMORY-LAYER budget gate.** `memory.layer.ts:137` usa `estimateTokens` para o threshold de
   skip de semantic-recall (`< tokenBudget - 200`); contagem mais acurada (maior) skipa o recall
   **mais cedo**. Benigno (mais conservador) — uma linha de nota p/ não confundir com regressão
   de cobertura de recall.

7. **Test constants drift.** `budget-enforcer.test.ts:20-30` sintetiza inputs assumindo
   `ceil(wordCount*1.3)`. Sob BPE, relações numéricas (budget vs MIN, "60 linhas > 400") podem
   precisar de re-ajuste de constantes. Testes auto-referentes (que derivam de
   `estimateTokens(...)`) ficam OK; os baseados em relação precisam reverificação ao rodar
   Phase 1+2 juntas. **Risco extra sob a carga async:** se um teste de `budget-enforcer` rodar
   *antes* do encoder warm-up (heurística) e outro *depois* (BPE), os números divergem na mesma
   suíte. Mitigação: forçar estado conhecido no `beforeAll` (ou `await` a carga, ou mockar p/
   fallback) — documentar a escolha no teste.

8. **Model-C NÃO é gated (achado adversarial — material).** `_dispatchModelCImpl`
   (`execution-handler.ts:189-473`) chama `runSurfaceAgentLoop` (`:377`) **sem `enforceBudget`**
   (verificado: 0 hits no range). Só o caminho ReAct (`handleExecution:1312`) passa pelo gate.
   **Impacto no escopo desta spec:** CTX-04 (contagem acurada) ajuda *qualquer* leitura de
   `estimateTokens`, mas CTX-05 (compressão convergente) só protege o caminho ReAct — no Model-C
   um prompt grande vai cru pro provider, mesmo com a contagem correta. Pior: a auditoria diz que
   **o piloto SDR é OpenAI Model-C** (open question 3), i.e. o caminho de produção é exatamente o
   ungated. Isto **não está em escopo** desta spec (CTX-02 declarou Model-C como follow-up,
   `budget-enforcer.ts:22-23`), mas **invalida a afirmação "gate vivo único p/ ReAct e Model-C"**
   que aparecia no draft. Levantado como finding próprio (CTX-07?) — ver open question 4.

9. **`withinBudget === false` não é só head-only.** O campo é `finalTokens <= budgetTokens`. É
   `false` em **dois** casos de piso, não um: (a) marker presente e `head >= budget`; (b) marker
   ausente e as 3 linhas-piso já estouram. O draft dizia "só head-only" — corrigido em §4.2.1. O
   teste de invariante **não pode** assertar `finalTokens <= budget` p/ todo `wasCompressed`: deve
   condicionar a `withinBudget` (tautologia) e só exigir `true` p/ inputs comprovadamente
   compressíveis (linhas << budget). Caso contrário o próprio teste de "terminação patológica"
   falharia a invariante.

### Open questions

1. **Onde a razão de calibração deve aparecer** — só atributo OTel, ou também realimentar um
   auto-tune do multiplicador de fallback? **Recomendo telemetry-only primeiro** (medir antes de
   automatizar). Founder decide.
2. **`enforceBudget` deveria reservar headroom** para o user message + output esperado? Hoje só
   conta `systemPrompt + tools`; o user turn é appendado **após** o gate
   (`execution-handler.ts:1356-1360`). Contagem acurada (CTX-04) torna a omissão mais visível —
   um prompt "que cabe" pode estourar ao adicionar o user turn. Provavelmente finding separado
   (CTX-06?); flagado aqui porque a precisão o expõe.
3. **Acurácia não-OpenAI** é necessária para o piloto SDR? A auditoria diz piloto é OpenAI
   Model-C → encoder-per-provider fica **fora de escopo**. Confirmar com maintainer; decide se
   `o200k_base` único basta ou se precisa de encoder-per-provider (in/out de escopo).
4. **Estender `enforceBudget` ao caminho Model-C** (risco 8)? Dado que o piloto é Model-C, a
   contagem acurada de CTX-04 sem o gate no caminho que importa entrega só metade do valor.
   Opções: (a) abrir finding/issue separado (CTX-07) e manter esta spec focada nos dois módulos;
   (b) puxar o wiring de 1 linha `enforceBudget` para dentro de `_dispatchModelCImpl` antes de
   `runSurfaceAgentLoop` (`:377`) como rider desta entrega. **Recomendo (a)** — manter blast-radius
   pequeno e não alargar escopo; mas **founder decide** se o piloto Model-C torna (b) urgente.

## §9. Definition of done

- [ ] **Phase 1 (CTX-04 tokenizer):**
  - [ ] `js-tiktoken` adicionado a `package.json` + lockfile commitado; import via
        `js-tiktoken/lite` + `js-tiktoken/ranks/o200k_base` (NÃO o entry default — §8 risco 1)
  - [ ] `tokenizer.ts` — encoder lazy singleton (`import()` do rank único) + fallback fail-open +
        `isUsingFallbackTokenizer`; assinatura `estimateTokens(text): number` inalterada
  - [ ] `tokenizer.test.ts` — pin 1.3 removido; golden BPE `o200k_base` (EN+PT-BR+emoji+JSON, com
        encoder `await`-ado pronto); fallback testado (mock do `import()` rejeitando); 4 casos
        genéricos verdes; determinismo notado como por-tick
  - [ ] Decisão `cl100k_base` vs `o200k_base` confirmada (recomendado: `o200k_base` p/ gpt-4o-mini)
- [ ] **Phase 2 (CTX-05 convergência):**
  - [ ] `truncatePromptToBudget` iterativo bounded (≤6) + head-preserving + pisos terminais
  - [ ] `EnforcedContext.withinBudget` adicionado + setado nos **3 return paths** (under/warning/compressed)
  - [ ] `budget-enforcer.test.ts` — tautologia `withinBudget===(finalTokens<=budget)`; convergência
        p/ prompt compressível; regressão single-pass; terminação ≤6 iter; 9 casos existentes verdes
  - [ ] (Opcional) `context.within_budget` span attr no handler
- [ ] **Phase 3 (calibração):**
  - [ ] `estimatedPromptTokens` capturado pós-gate; `onUsage` emite
        `context.token_estimate_ratio` + `context.tokenizer_fallback`
  - [ ] `tokenizer-calibration.test.ts` — razão estimate-vs-actual
- [ ] Compila sem warnings; `npm run lint` limpo
- [ ] Hot-path: confirmado no review que NÃO há `new Tiktoken(...)`/`import()` por-call
      (singleton lazy); e que o import é `js-tiktoken/lite` (não puxa os 7 vocabs)
- [ ] Sem regressões (`npm run test` full verde)
- [ ] Compat PR #61 verificada (sem conflito em `tokenizer.ts`/`budget-enforcer.ts`; só
      `COMPRESSIBLE_MARKER` compartilhado, importado)
- [ ] Audit findings CTX-04 + CTX-05 validados como closed
- [ ] Code review aprovado (tokenizer + budget-enforcer + wiring)

## §10. References

- **Issue:** bernardTavares/bevox-harness#62 (a abrir)
- **Audit findings:** CTX-04 (tokenizer heurístico), CTX-05 (compressão single-pass) —
  `docs/audits/` (runtime-gap-audit-2026-06-02)
- **PR relacionada (compat, NÃO assumir merged):** PR #61, branch `ctx-builder` — reescreve
  `ContextBuilder.build()` (allSettled + timeout por layer) + `foldContext(...,{withMarker})`;
  **não toca** `tokenizer.ts`/`budget-enforcer.ts`; seta `maxContextTokens: undefined` →
  bypassa `compress()` interno; `enforceBudget` é o gate vivo único **no caminho ReAct** (Model-C
  ungated — §8 risco 8).
- **Código fonte (verificado linha-a-linha):**
  - `src/context/tokenizer.ts:16-22` (`estimateTokens` heurístico `words×1.3`); cabeçalho
    `:1-9` (justificativa do 1.3)
  - `src/context/budget-enforcer.ts:113-124` (`estimateToolTokens` JSON.stringify+word-split),
    `:140` (`COMPRESSIBLE_MARKER`), `:158-199` (`enforceBudget`), `:176-185`
    (warning-not-abort `MIN_PROMPT_TOKENS=200`), `:212-245` (`truncatePromptToBudget`
    single-pass), `:80-101` (`EnforcedContext`)
  - `src/context/context-builder.ts:32-64` (`compress()` single-pass — segundo-site, bypassed
    sob #61), `:60` (caller `estimateTokens`; **`:71` NÃO chama** `estimateTokens` — apenas soma
    `tokenEstimate` pré-computados via reduce)
  - `src/context/layers/memory.layer.ts:137` (skip recall `< tokenBudget-200`), `:178`
  - `src/integration/llm/usage-decorator.ts:37-50` (`onUsage` seam), `:27-29` (`UsageCallback`)
  - `src/integration/llm-gateway.ts:50-54` (`LLMResponse.usage`), `:202-203`
    (`UsageDecorator` wiring)
  - `src/runtime/execution-handler.ts:910-918` (`usageAccumulator` + `onUsage` wiring; `rootSpan`
    em escopo desde `:850`), `:1312` (`enforceBudget` gate vivo — caminho ReAct/`handleExecution`),
    `:1326-1353` (span attrs CTX-02 + assign), `:1356-1360` (user message appendado APÓS o gate →
    open question 2)
  - `src/runtime/execution-handler.ts:189-473` (`_dispatchModelCImpl` — caminho Model-C; chama
    `runSurfaceAgentLoop` em `:377` **sem `enforceBudget`**; verificado 0 hits no range — §8 risco 8)
  - Demais callers `estimateTokens`: `base-config.layer.ts:14`, `rules.layer.ts:35`,
    `calendar.layer.ts:102`, `history.layer.ts:76`
  - Testes: `tests/unit/context/tokenizer.test.ts:39-43` (pin 1.3 a remover),
    `tests/unit/context/budget-enforcer.test.ts:13-30,109-127,131-161` (9 casos a manter)
  - **Morto (NÃO estender):** `src/context/tokenizer.test.ts` (co-located; vitest
    `include: ['tests/**/*.test.ts']` em `vitest.config.ts`)
- **Deps:** `package.json` — sem tokenizer BPE hoje; adicionar `js-tiktoken` (v1.0.21, pure-JS,
  não WASM). ⚠️ Importar via `js-tiktoken/lite` + `js-tiktoken/ranks/o200k_base`: o entry default
  (`dist/index.js`, ~5.4 MB) embute estaticamente os 7 rank tables (verificado no tarball — só
  `base64-js` como dep transitiva).
- **Rule files:** `.claude/rules/harness-llm.md` (OpenAI primário, Gemini secundário,
  Anthropic pós-V1)
- **Specs relacionadas:**
  - `2026-06-02-context-builder-runtime-instantiation-design.md` (CTX-01 / PR #61 — o fold
    marker-aware que herda este fix)
