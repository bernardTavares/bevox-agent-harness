# Sprint D.1: Dev Playground UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir uma UI web local (Vite + React) para inspecionar execuções do harness em tempo real — spans OTEL, prompts LLM, tool calls, custo, e time-travel debugging na timeline. Inspirado em Mastra Studio, mas implementado in-house para ter controle total de UX e zero dependência externa de runtime.

**Architecture:** App Vite/React separado em `playground/` (workspace npm). O harness, quando rodado com `HARNESS_DEV_MODE=1`, expõe um WebSocket server em `src/dev/ws-server.ts` que publica eventos OTEL processados (spans iniciados/finalizados, prompts, tool inputs/outputs, decisões de escalation). O Playground conecta via WS, renderiza um feed ao vivo de execuções, e permite drill-down em qualquer execução individual com timeline navegável. **Não** roda em produção (`HARNESS_DEV_MODE` é flag explícita; bootstrap nega init do WS server se `NODE_ENV=production`).

**Tech Stack:** Vite 5, React 18, TypeScript 5.9, `ws` (server), `react-use-websocket` (client), Tailwind CSS 3 + shadcn/ui (visual), Zustand (state), date-fns (formatação).

---

## Dependencies

- **Hard:** Nenhuma estrita. Funciona stand-alone exibindo eventos brutos.
- **Soft:** Fase 4 (Observability) — sem OTEL spans, a UI degrada para exibir apenas eventos de execution-handler. Com F4 mergeada, ganha timeline completa.
- **Blocks:** Nenhuma fase futura depende deste plano. É opcional e dev-only.
- **Conflitos potenciais:** Mínimos. Adiciona workspace novo; toca `package.json` raiz, `src/runtime/execution-handler.ts` (hook de emissão) e `src/bootstrap/stages.ts` (registrar dev stage).

## Files Touched

### Create — workspace `playground/`
- `playground/package.json`
- `playground/tsconfig.json`
- `playground/vite.config.ts`
- `playground/index.html`
- `playground/tailwind.config.ts`
- `playground/postcss.config.js`
- `playground/src/main.tsx`
- `playground/src/App.tsx`
- `playground/src/api/ws-client.ts`
- `playground/src/state/store.ts` (Zustand)
- `playground/src/state/types.ts` (tipos compartilhados com `src/dev/`)
- `playground/src/views/executions-list.tsx`
- `playground/src/views/execution-detail.tsx`
- `playground/src/views/timeline.tsx`
- `playground/src/views/prompts-panel.tsx`
- `playground/src/views/traces-panel.tsx`
- `playground/src/components/{span-bar,filter-bar,replay-slider,json-viewer}.tsx`

### Create — harness side
- `src/dev/ws-server.ts` (servidor WS + broadcaster)
- `src/dev/event-bus.ts` (EventEmitter interno; abstração para hook OTEL → WS)
- `src/dev/otel-bridge.ts` (SpanProcessor custom que publica spans no event bus)
- `src/dev/types.ts` (eventos: `ExecutionStarted`, `SpanFinished`, `LLMCall`, `ToolCall`, `ExecutionCompleted`)

### Modify
- ⚠️ `package.json` (raiz) — adicionar `"workspaces": ["playground"]`, script `playground`, deps `ws` + `@types/ws`
- ⚠️ `src/bootstrap/stages.ts` — novo estágio condicional `start-dev-ws` (só roda se `HARNESS_DEV_MODE=1` e `NODE_ENV !== "production"`)
- ⚠️ `src/runtime/execution-handler.ts` — emitir eventos no event bus (delta mínimo: 4-5 chamadas `eventBus.emit(...)`)
- `src/config/env.ts` — adicionar `HARNESS_DEV_MODE` (default false) e `HARNESS_DEV_WS_PORT` (default 4400)
- `README.md` — seção "Dev Playground"

### High-conflict files
- ⚠️ `src/runtime/execution-handler.ts` — qualquer outra phase tocando o handler vai conflitar (F3, F4)
- ⚠️ `src/bootstrap/stages.ts` — F4 também adiciona estágio

## Estimated Effort
5-6 semanas (~120-150 horas). Maior componente do Sprint D — é essencialmente um sub-produto.

---

## Tasks

### Task 1: Setup workspace `playground/`

**Files:**
- Create: `playground/package.json`, `playground/tsconfig.json`, `playground/vite.config.ts`, `playground/index.html`
- Modify: `package.json` (raiz)

- [ ] **Step 1: Configurar workspaces no `package.json` raiz**

```json
{
  "workspaces": ["playground"],
  "scripts": {
    "playground": "concurrently -k -n harness,ui \"HARNESS_DEV_MODE=1 npm run dev\" \"npm -w playground run dev\"",
    "playground:ui": "npm -w playground run dev"
  }
}
```

⚠ Adicionar `concurrently` como devDep raiz: `npm i -D concurrently`.

- [ ] **Step 2: `playground/package.json`**

```json
{
  "name": "@bevox/playground",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-use-websocket": "^4.8.1",
    "zustand": "^4.5.4",
    "date-fns": "^3.6.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.9.0",
    "vite": "^5.4.0",
    "tailwindcss": "^3.4.7",
    "postcss": "^8.4.40",
    "autoprefixer": "^10.4.19"
  }
}
```

- [ ] **Step 3: `playground/vite.config.ts`** — proxy WS opcional

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 4401, strictPort: true },
});
```

- [ ] **Step 4: `playground/tsconfig.json`** — extends do raiz, `jsx: react-jsx`, `paths` para `@harness/dev-types` apontando para `../src/dev/types.ts`

- [ ] **Step 5: Tailwind + index.html minimalistas**

- [ ] **Step 6: Smoke test**

```bash
npm -w playground install
npm -w playground run dev
```
Expected: Vite sobe em `http://localhost:4401`, página em branco renderiza sem erro.

- [ ] **Step 7: Commit**

```bash
git commit -m "chore(playground): scaffold vite/react workspace"
```

---

### Task 2: Event bus interno + tipos compartilhados

**Files:**
- Create: `src/dev/event-bus.ts`, `src/dev/types.ts`
- Create: `playground/src/state/types.ts` (re-export tipos para evitar import cross-workspace problemático)

- [ ] **Step 1: `src/dev/types.ts`** — discriminated union de eventos

```typescript
export type DevEvent =
  | { kind: "execution.started"; executionId: string; accountId: number; ts: number; payload: unknown }
  | { kind: "execution.completed"; executionId: string; ts: number; durationMs: number; status: "ok" | "error" }
  | { kind: "span.finished"; executionId: string; name: string; ts: number; durationMs: number; attrs: Record<string, unknown>; parentSpanId?: string; spanId: string }
  | { kind: "llm.call"; executionId: string; ts: number; provider: string; model: string; prompt: string; response: string; tokens: { input: number; output: number }; latencyMs: number; purpose?: string }
  | { kind: "tool.call"; executionId: string; ts: number; tool: string; params: unknown; result: unknown; success: boolean; latencyMs: number }
  | { kind: "reasoning.step"; executionId: string; ts: number; engine: string; stepIndex: number; action?: string; observation?: string };
```

- [ ] **Step 2: `src/dev/event-bus.ts`** — singleton EventEmitter no-op em produção

```typescript
import { EventEmitter } from "node:events";
import type { DevEvent } from "./types";

class DevEventBus extends EventEmitter {
  emitEvent(event: DevEvent) {
    this.emit("event", event);
  }
}

let instance: DevEventBus | null = null;

export function getDevEventBus(): DevEventBus {
  if (!instance) instance = new DevEventBus();
  return instance;
}

export function isDevModeEnabled(): boolean {
  return process.env.HARNESS_DEV_MODE === "1" && process.env.NODE_ENV !== "production";
}
```

⚠ Importante: `emitEvent` é chamado incondicionalmente nos hooks; o **listener** só é adicionado se dev mode. Custo em produção: 1 chamada `emit` sem listeners ≈ microssegundos.

- [ ] **Step 3: Tipo `DevEvent` re-exportado em `playground/src/state/types.ts`**

Solução pragmática: copiar o tipo (manter sincronizado manualmente — diff pequeno). Alternativa via path alias é frágil em workspaces.

- [ ] **Step 4: Testes unitários no event-bus**

```typescript
it("singleton retorna mesma instância", () => {
  expect(getDevEventBus()).toBe(getDevEventBus());
});
it("isDevModeEnabled false sem env", () => {
  delete process.env.HARNESS_DEV_MODE;
  expect(isDevModeEnabled()).toBe(false);
});
```

- [ ] **Step 5: Commit**

---

### Task 3: WS server + bridge OTEL

**Files:**
- Create: `src/dev/ws-server.ts`, `src/dev/otel-bridge.ts`
- Modify: `src/config/env.ts`, `src/bootstrap/stages.ts`

- [ ] **Step 1: Adicionar env vars**

```typescript
HARNESS_DEV_MODE: z.coerce.boolean().default(false),
HARNESS_DEV_WS_PORT: z.coerce.number().int().min(1024).max(65535).default(4400),
```

- [ ] **Step 2: `src/dev/ws-server.ts`**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { getDevEventBus, isDevModeEnabled } from "./event-bus";
import type { DevEvent } from "./types";
import { getLogger } from "../observability/logger";

let wss: WebSocketServer | null = null;
const log = getLogger("dev-ws-server");

export function startDevWsServer(port: number) {
  if (!isDevModeEnabled()) return;
  wss = new WebSocketServer({ port });
  log.info({ port }, "dev ws server listening");

  const bus = getDevEventBus();
  bus.on("event", (event: DevEvent) => {
    const msg = JSON.stringify(event);
    wss?.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
  });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ kind: "hello", version: 1 }));
  });
}

export async function stopDevWsServer() {
  await new Promise<void>((r) => wss?.close(() => r()) ?? r());
}
```

- [ ] **Step 3: `src/dev/otel-bridge.ts`** — `SpanProcessor` custom

⚠ Só registrar se F4 estiver presente (`OTEL_ENABLED=true`). Sem F4, o bridge é no-op; eventos chegam direto via `eventBus.emit` em Task 4.

```typescript
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { getDevEventBus } from "./event-bus";

export class DevEventSpanProcessor implements SpanProcessor {
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}
  onEnd(span: ReadableSpan): void {
    const ctx = span.spanContext();
    const executionId =
      (span.attributes["execution.id"] as string | undefined) ?? "unknown";
    getDevEventBus().emitEvent({
      kind: "span.finished",
      executionId,
      name: span.name,
      ts: span.endTime[0] * 1000 + Math.floor(span.endTime[1] / 1e6),
      durationMs: hrDurationMs(span.startTime, span.endTime),
      attrs: span.attributes as Record<string, unknown>,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanId,
    });
  }
}

function hrDurationMs(start: [number, number], end: [number, number]) {
  return (end[0] - start[0]) * 1000 + (end[1] - start[1]) / 1e6;
}
```

- [ ] **Step 4: Registrar SpanProcessor no `tracer.ts` da F4** — só se F4 mergeada

```typescript
sdk = new NodeSDK({
  // ... config existente
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT })),
    ...(isDevModeEnabled() ? [new DevEventSpanProcessor()] : []),
  ],
});
```

- [ ] **Step 5: Estágio bootstrap `start-dev-ws`**

```typescript
// src/bootstrap/stages.ts
import { startDevWsServer } from "../dev/ws-server";
import { isDevModeEnabled } from "../dev/event-bus";

export function startDevWsStage(): Stage {
  return {
    name: "start-dev-ws",
    async run() {
      if (!isDevModeEnabled()) return;
      startDevWsServer(getEnv().HARNESS_DEV_WS_PORT);
    },
  };
}
```

Inserir entre `init-observability` (F4) e `start-consumer`.

- [ ] **Step 6: Graceful shutdown** — registrar `stopDevWsServer` no `shutdown.ts`

- [ ] **Step 7: Smoke test manual**

```bash
HARNESS_DEV_MODE=1 npm run dev
# em outro terminal:
npx wscat -c ws://localhost:4400
# Expected: recebe {"kind":"hello","version":1}
```

- [ ] **Step 8: Commit**

---

### Task 4: Hooks no `execution-handler.ts` para emitir eventos

**Files:**
- Modify: `src/runtime/execution-handler.ts`

- [ ] **Step 1: Importar e chamar bus**

```typescript
import { getDevEventBus, isDevModeEnabled } from "../dev/event-bus";

// no início de handleExecution, após Zod parse:
const bus = isDevModeEnabled() ? getDevEventBus() : null;
const startTs = Date.now();
bus?.emitEvent({
  kind: "execution.started",
  executionId: payload.execution_id,
  accountId: payload.account?.id ?? payload.account_id,
  ts: startTs,
  payload: { messages: payload.messages?.slice(-3) /* anti-PII: só últimas 3 */ },
});

// no final (sucesso ou erro):
bus?.emitEvent({
  kind: "execution.completed",
  executionId: payload.execution_id,
  ts: Date.now(),
  durationMs: Date.now() - startTs,
  status: error ? "error" : "ok",
});
```

- [ ] **Step 2: Hook em LLM calls — via decorator no LLMGateway**

⚠ Realidade: `LLMGateway.complete` em `src/integration/llm-gateway.ts`. Adicionar decorator que envolve adapter (similar ao usage tracker da F4):

```typescript
// src/integration/llm/dev-emitter-decorator.ts (criar)
export class DevEmitterLLM implements LLMProvider {
  constructor(private inner: LLMProvider) {}
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const t0 = Date.now();
    const res = await this.inner.complete(options);
    if (isDevModeEnabled() && options.meta?.executionId) {
      getDevEventBus().emitEvent({
        kind: "llm.call",
        executionId: options.meta.executionId,
        ts: Date.now(),
        provider: res.provider,
        model: res.model,
        prompt: truncateForDisplay(JSON.stringify(options.messages)),
        response: truncateForDisplay(res.content ?? ""),
        tokens: { input: res.usage.input_tokens, output: res.usage.output_tokens },
        latencyMs: Date.now() - t0,
        purpose: options.meta.purpose,
      });
    }
    return res;
  }
}
function truncateForDisplay(s: string, max = 4000) { return s.length > max ? s.slice(0, max) + "…" : s; }
```

Compor na ordem: `DevEmitter → Usage → adapter`.

- [ ] **Step 3: Hook em tool calls — instrumentar o `executeTool` closure**

```typescript
// dentro de handleExecution, no closure executeTool:
const executeTool: ToolExecutor = async (toolName, params, toolContext) => {
  const t0 = Date.now();
  const tool = toolRegistry.resolveOrThrow(toolName);
  const result = await tool.execute(params, toolContext);
  bus?.emitEvent({
    kind: "tool.call",
    executionId: payload.execution_id,
    ts: Date.now(),
    tool: toolName,
    params,
    result: result.success ? result.data : { error: result.error },
    success: result.success,
    latencyMs: Date.now() - t0,
  });
  return result;
};
```

⚠ Se F4 já instrumentou esse closure com span, manter ambos (span + dev event). Não conflita.

- [ ] **Step 4: Teste integrado** — InMemoryWSClient mock + executa handler mock

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(dev): emit execution events to dev event bus"
```

---

### Task 5: WS client + Zustand store no Playground

**Files:**
- Create: `playground/src/api/ws-client.ts`, `playground/src/state/store.ts`

- [ ] **Step 1: `ws-client.ts`** — reconnect automático, parse de eventos

```typescript
import useWebSocket from "react-use-websocket";
import { useStore } from "../state/store";

export function useDevWebSocket() {
  return useWebSocket("ws://localhost:4400", {
    shouldReconnect: () => true,
    reconnectInterval: 1500,
    onMessage: (msg) => {
      const event = JSON.parse(msg.data);
      useStore.getState().ingest(event);
    },
  });
}
```

- [ ] **Step 2: `store.ts`** — Zustand com index por executionId

```typescript
import { create } from "zustand";
import type { DevEvent } from "./types";

interface ExecutionState {
  id: string;
  accountId?: number;
  startedAt: number;
  completedAt?: number;
  status: "running" | "ok" | "error";
  spans: SpanRecord[];
  llmCalls: LLMCallRecord[];
  toolCalls: ToolCallRecord[];
}

interface State {
  executions: Map<string, ExecutionState>;
  ingest(event: DevEvent): void;
  clear(): void;
}

export const useStore = create<State>((set) => ({
  executions: new Map(),
  ingest: (event) => set((s) => {
    const map = new Map(s.executions);
    const ex = map.get(event.executionId) ?? blank(event.executionId);
    applyEvent(ex, event);
    map.set(event.executionId, ex);
    // cap: manter últimas 200 execuções para evitar memory leak
    if (map.size > 200) {
      const oldest = [...map.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      map.delete(oldest.id);
    }
    return { executions: map };
  }),
  clear: () => set({ executions: new Map() }),
}));
```

- [ ] **Step 3: Helpers `blank()` e `applyEvent()` com discriminated union**

- [ ] **Step 4: Smoke**

```bash
npm run playground
```
Expected: dispatch de job no harness aparece como linha no store (verificar via React DevTools).

- [ ] **Step 5: Commit**

---

### Task 6: View — lista de execuções

**Files:**
- Create: `playground/src/views/executions-list.tsx`, `playground/src/components/filter-bar.tsx`

- [ ] **Step 1: Componente `<ExecutionsList />`**

- Tabela: `executionId` (curto, 8 chars) | `accountId` | `startedAt` (relative) | `duration` | `status` | spans count | LLM calls count | total cost
- Sort default: `startedAt desc`
- Click → navega para detail
- Indicador "running" pulsante

- [ ] **Step 2: `<FilterBar />`** — filtro por `accountId`, status, agent (extraído de spans `agent.name`), texto livre em prompts

- [ ] **Step 3: Auto-refresh contínuo** — Zustand já reativo, sem polling extra

- [ ] **Step 4: Empty state** — "Sem execuções ainda. Dispare um job no harness."

- [ ] **Step 5: Commit**

---

### Task 7: View — detalhe de execução com timeline

**Files:**
- Create: `playground/src/views/execution-detail.tsx`, `playground/src/views/timeline.tsx`, `playground/src/components/span-bar.tsx`

- [ ] **Step 1: Layout em 3 colunas**

```
┌─────────────────────────────────────────────────────────┐
│ Header: executionId, accountId, status, duration        │
├─────────────────────────────────────────────────────────┤
│ Timeline (full width, scrollable, zoomable)             │
├──────────────┬──────────────────────┬───────────────────┤
│ Span tree    │ Inspector (centro)   │ Custo/Tokens      │
│ (esquerda)   │ — prompts/tools/json │ (direita)         │
└──────────────┴──────────────────────┴───────────────────┘
```

- [ ] **Step 2: Timeline (`<Timeline />`)**

- Cada span = barra horizontal posicionada por `startTs/endTs` relativos ao `execution.started`
- Cor por categoria: `pipeline.*` azul, `surface.*` verde, `tool.*` laranja, `llm.*` roxo
- Hover → tooltip com atributos
- Click → seleciona span (atualiza Inspector)

- [ ] **Step 3: `<SpanBar />`** — barra individual com label truncada + duration

- [ ] **Step 4: Span tree à esquerda** — indentação por `parentSpanId`

- [ ] **Step 5: Painel direito de custo** — soma `tokens` e `cost` (se F4 mergeada e mandar via attrs)

- [ ] **Step 6: Commit**

---

### Task 8: Inspector — prompts, tools, traces

**Files:**
- Create: `playground/src/views/prompts-panel.tsx`, `playground/src/views/traces-panel.tsx`, `playground/src/components/json-viewer.tsx`

- [ ] **Step 1: `<JsonViewer />`** — render JSON colapsável, syntax highlight (sem dep externa: implementar com `<pre>` + JSON.stringify indent 2 + regex highlight). Alternativa: `react-json-view-lite`.

- [ ] **Step 2: `<PromptsPanel />`** — para `llm.call` selecionada: render markdown do prompt (system/user/assistant turns) + response side-by-side

- [ ] **Step 3: `<TracesPanel />`** — para `tool.call`: `params` e `result` lado a lado em JsonViewer

- [ ] **Step 4: Tab switcher** — Inspector mostra painel correspondente ao tipo do span/evento selecionado

- [ ] **Step 5: Copy-to-clipboard** em prompts e JSON

- [ ] **Step 6: Commit**

---

### Task 9: Time-travel debugging (slider)

**Files:**
- Create: `playground/src/components/replay-slider.tsx`
- Modify: `playground/src/views/execution-detail.tsx`

- [ ] **Step 1: Slider de tempo** — controla "instante T" relativo ao início da execução

- [ ] **Step 2: Timeline e árvore filtram eventos com `ts <= T`**

- [ ] **Step 3: Inspector destaca último evento antes de T**

- [ ] **Step 4: Botões play/pause/step** — auto-avançar T em velocidade configurável (1x, 2x, 5x, max)

- [ ] **Step 5: UX:** persistir T em URL (`?t=1234`) para compartilhar links

⚠ Limitação consciente: time-travel é **visual only** — não re-executa o agent. Replay real fica para futuro (precisaria de snapshots determinísticos).

- [ ] **Step 6: Commit**

---

### Task 10: Polish visual + acessibilidade

**Files:**
- Modify: vários no `playground/src/`

- [ ] **Step 1: Tema escuro por default**, toggle light no header
- [ ] **Step 2: Atalhos** — `/` foca busca, `j/k` navega execuções, `Esc` volta para lista
- [ ] **Step 3: Responsivo** — mínimo 1280px (dev tool, não mobile)
- [ ] **Step 4: Estados de loading e erro de WS** — banner "Disconnected. Reconnecting…"
- [ ] **Step 5: Commit**

---

### Task 11: Documentação

**Files:**
- Create: `playground/README.md`
- Modify: `README.md` (raiz)

- [ ] **Step 1: `playground/README.md`** — como rodar, arquitetura, screenshots (placeholder)

- [ ] **Step 2: Seção "Dev Playground" no README raiz**

```markdown
## Dev Playground

```bash
npm run playground
# harness sobe com HARNESS_DEV_MODE=1
# UI abre em http://localhost:4401
```

⚠ NUNCA rodar com `HARNESS_DEV_MODE=1` em produção. O bootstrap nega init do WS server se `NODE_ENV=production`.
```

- [ ] **Step 3: Commit**

---

### Task 12: Validação end-to-end + PR

- [ ] **Step 1: Cenários manuais a validar**

1. Dispatch de execução simples (Direct engine) → aparece na lista, drill-down mostra spans corretos
2. Dispatch com escalation (ReAct → Plan&Execute) → timeline reflete 2 engines
3. Dispatch com erro → status "error" no header, span com `error.category`
4. 50 execuções em paralelo → UI não trava, lista limita a 200
5. WS desconectado e reconecta → banner aparece e some

- [ ] **Step 2: Smoke build production-mode**

```bash
NODE_ENV=production HARNESS_DEV_MODE=1 npm run dev
```
Expected: log "dev ws server skipped: NODE_ENV=production"

- [ ] **Step 3: PR**

```bash
git push origin HEAD:sprint-d-1-playground
gh pr create --title "Sprint D.1: Dev Playground UI" --body-file docs/superpowers/plans/2026-05-14-sprint-d-1-playground-ui.md
```

---

## Definition of Done

- ✅ `npm run playground` sobe harness em dev mode + UI Vite, abre browser automaticamente (ou imprime URL)
- ✅ Execuções ao vivo aparecem na lista em < 200ms após dispatch
- ✅ Drill-down em execução mostra timeline com todos os spans (mínimo: handle, pipeline, surface, tool calls, llm calls)
- ✅ Prompts e respostas LLM legíveis no Inspector
- ✅ Filtros (account, status, texto) funcionam
- ✅ Time-travel slider funcional
- ✅ WS server **não inicia** em `NODE_ENV=production` (testado)
- ✅ Sem regressão de performance no harness (benchmark: emissão de eventos < 1ms por execução)
- ✅ README e `playground/README.md` documentam fluxo

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Playground vira "produto" e atrasa entregas core | Time-box rígido de 6 semanas; features extras (replay real, persistência, multi-user) explicitamente fora de escopo |
| Vazamento de PII em dev mode em logs/screenshots | Truncar prompts a 4KB; documentar que dev mode é local-only; nunca expor porta WS externamente; banner de aviso na UI |
| Performance da WS com muitas execuções | Cap de 200 execuções na store; debounce em re-renders (zustand selectors); paginação na timeline |
| Manter tipos sincronizados entre harness e playground | Copiar `DevEvent` em ambos + teste de integridade JSON schema entre os dois (validar com Zod em ambos os lados) |
| Conflito com OTEL config se F4 não mergeada | `otel-bridge.ts` só registra se `tracer.ts` da F4 existir; sem F4, eventos chegam direto via `eventBus` (degrade gracioso) |
| Drift entre o que UI mostra e realidade do harness | Inspector exibe `attrs` brutos do span — fonte de verdade. Não inventar dados |
| Segurança: WS sem auth | Bind apenas em `127.0.0.1` (não `0.0.0.0`); recusar conexões de origens externas no upgrade handler |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. Consultar [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14) para decisões globais.

### Critical
- **Task 0 (nova)** — Husky no-verify (G.6) + dep em `LLMRequestOptions.meta` field (G.3) prerequisito.
- **Script `playground` cross-platform (G.7)** — Adicionar `cross-env` como devDep e usar `cross-env HARNESS_DEV_MODE=1 npm run dev`. Sintaxe POSIX `VAR=1 cmd` quebra em Windows.
- **`DevEmitterLLM` type** — Decorator é `LLMGateway`, não `LLMProvider` (não existe). Ordem de composição: outermost antes de `RetryDecorator` para capturar latência total incluindo retries. Documentar em Task 4.
- **Workspaces impact** — Smoke-test `npm run build` na raiz APÓS habilitar workspaces antes de seguir. Adicionar `playground/` a `.eslintignore`, `.prettierignore`. `tsconfig.json` raiz já tem `include: ["src"]` (OK).

### Important
- **WS auth defesa em profundidade** — Tornar explícito em Task 3 Step 2: `new WebSocketServer({ port, host: "127.0.0.1" })`. Adicionar `Origin` check no `upgrade` handler (rejeita externa para evitar DNS rebinding).
- **`## Out of Scope` section** — Adicionar lista declarativa: (1) replay determinístico, (2) persistência além de in-memory, (3) auth real, (4) export, (5) live edit prompt. Permite rejeitar scope creep.
- **OTLP collector clarification** — README do playground: não sobe collector, spans direto do SDK para event bus in-process. Evita confusão com F4.
- **Backpressure WS broadcast** — Checar `c.bufferedAmount > THRESHOLD` (1MB) antes de send, drop + métrica `dev.ws.dropped_events`.
- **Cap 200 execs teste** — Adicionar cenário 500 execuções (gerador sintético), verificar memória estável.
- **Prompt truncation config** — Tornar configurável `HARNESS_DEV_PROMPT_MAX_BYTES` (default 8192).

### Nitpick
- Pin tipos (`@types/node`) alinhados com raiz.
- Task 9 (time-travel) marcar como P2/MVP-opcional para reduzir time-box 6 semanas.
- `react-json-view-lite` (3KB) em vez de reimplementar JSON viewer.
- Workspace name padronizar `@bevox-harness/playground`.
