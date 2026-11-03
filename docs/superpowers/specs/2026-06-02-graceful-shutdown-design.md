# Graceful Shutdown — Wire Real Resource Handles on SIGTERM/SIGINT — Design

> **Spec ID:** `2026-06-02-graceful-shutdown-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Opus 4.8) — Backend Architect, 2026-06-02 (research double-checked contra o código)
> **Escopo:** bevox-harness audit finding BOOT-002 (process lifecycle — shutdown não fecha DB pool / Redis / não drena worker explicitamente via handles reais) + tangencia BOOT-005 (cobertura ZERO em `src/bootstrap/*`)
> **Estimate:** ~3–4h (2 phases)
> **Issue:** bernardTavares/bevox-harness (BOOT-002)

> **⚠️ Nota de escopo.** Esta entrega é deliberadamente **minimal-change**. A
> infraestrutura de shutdown **já existe e é capaz** (`src/bootstrap/shutdown.ts`
> drena o worker, fecha redis/db quando presentes, faz flush de OTel/MCP/dev-ws).
> O defeito é **puramente de cablagem**: `src/index.ts:5` chama
> `registerShutdownHandlers({})` com um objeto **vazio** — então os ramos
> `resources.redis.quit()` (`shutdown.ts:52`) e `resources.db.end()`
> (`shutdown.ts:58`) **nunca rodam**. Não reescrevemos o subsistema; threadamos o
> `BootstrapContext` que `runBootstrap()` já retorna (`runner.ts:35`) e ampliamos o
> `ShutdownResources` para cobrir os 2 handles de ciclo-de-vida adicionais
> (eval worker, condense queue) que hoje **não têm caminho de close algum**.
> Rejeitamos transformar isto num "subsistema de lifecycle" — reusamos apenas os
> `stop()`/`close()` que **já existem** em cada handle.

## §1. Context

O harness é um **processo worker long-running** (2 réplicas worker-only na Hetzner,
per `CLAUDE.md`) sem porta HTTP exposta. O ciclo de vida é orquestrado por dois pontos:

- **Bootstrap** (`src/bootstrap/runner.ts:13-36`) cria os recursos donos do processo:
  ```typescript
  const db = new Pool({ connectionString: config.db.connectionString });   // runner.ts:16
  const redis = new Redis(config.redis.url, { lazyConnect: true });        // runner.ts:17
  await redis.connect();                                                   // runner.ts:18
  const ctx: BootstrapContext = { db, redis };                            // runner.ts:20
  // ... roda 7 stages ...
  return ctx;                                                              // runner.ts:35
  ```
  `BootstrapContext` é `{ db: Pool; redis: Redis }` (`stages.ts:65-68`).

- **Shutdown** (`src/bootstrap/shutdown.ts`) já está implementado e **é capaz**.
  `registerShutdownHandlers(resources)` (`shutdown.ts:19-71`) instala
  `process.on("SIGTERM"/"SIGINT")` (`shutdown.ts:69-70`) e um `shutdown()` async que,
  em ordem:
  1. `await stopConsumer()` (`shutdown.ts:25`) — drena o BullMQ Worker principal.
  2. `await stopDevWsServer()` guarded (`shutdown.ts:28-32`).
  3. `McpClientRegistry.getInstance().closeAll()` guarded (`shutdown.ts:36-40`).
  4. `await shutdownTracer()` guarded (`shutdown.ts:43-47`) — flush OTel.
  5. `if (resources.redis) await resources.redis.quit()` (`shutdown.ts:50-53`).
  6. `if (resources.db) await resources.db.end()` (`shutdown.ts:56-59`).
  7. `process.exit(0)` (`shutdown.ts:62`), ou `process.exit(1)` em erro (`shutdown.ts:65`).

  `ShutdownResources` (`shutdown.ts:14-17`) é `{ db?: Pool; redis?: Redis }` — ambos **opcionais**.

**O worker DRAIN já está cablado corretamente.** `stopConsumer()`
(`bullmq-consumer.ts:45-51`) faz `await activeWorker.close()` (`bullmq-consumer.ts:48`).
O `Worker.close()` do BullMQ, por padrão, **espera os jobs in-flight terminarem** antes de
fechar — logo o "deixar execuções em voo terminarem" já acontece. O Worker principal cria sua
**própria conexão Redis interna** a partir de `config.redis.url`
(`bullmq-consumer.ts:32`), independente de `ctx.redis`, e `worker.close()` fecha essa conexão.

## §2. Problem statement

**Gap 1 (o finding literal BOOT-002) — `resources` é `{}`, então pool e Redis vazam.**
`src/index.ts:4-8`:
```typescript
const main = async (): Promise<void> => {
  registerShutdownHandlers({});   // ← index.ts:5 — objeto VAZIO
  await runBootstrap();           // ← index.ts:6 — contexto retornado é DESCARTADO
  console.log("Agent Harness is running");
};
```
Dois defeitos compostos:
- **(a) Ordem.** Handlers são registrados **antes** de `runBootstrap()`. Mesmo um argumento
  não-vazio não poderia carregar handles que ainda não existem.
- **(b) Vazio.** `{}` ⇒ `resources.db`/`resources.redis` são `undefined` ⇒ os ramos
  `resources.redis.quit()` (`shutdown.ts:52`) e `resources.db.end()` (`shutdown.ts:58`)
  **nunca executam**. Em SIGTERM/SIGINT a `Pool` pg (`runner.ts:16`) e o cliente ioredis de
  bootstrap (`runner.ts:17`) **nunca fecham** — conexões ficam penduradas até o OS reapear o
  processo. Só `stopConsumer()`/dev-ws/MCP/tracer disparam.

Bate exatamente com o audit (`docs/audits/runtime-gap-audit-2026-06-02.md:259-261`):
*"shutdown nunca fecha DB pool nem Redis — index.ts passa registerShutdownHandlers({}) vazio"*.

**Gap 2 — 2 handles de ciclo-de-vida não têm caminho de close NENHUM (nem modelados).**
Além dos 2 handles que o util conhece (db/redis), bootstrap cria recursos opt-in que
`shutdown.ts` **não fecha**:
- **Eval Worker** (`evals/eval-worker.ts:24` `startEvalWorker`, guardado via `setEvalWorker`,
  `evals/registry.ts:23`, getter `getEvalWorker()` `registry.ts:26`). É um BullMQ `Worker` com
  `.close()` — **nunca chamado**. ⚠️ **SHARES `ctx.redis`** (`stages.ts:564`
  `connection: ctx.redis`) — ver §8 risco 4.
- **Condense Queue** (`integration/condense-queue.ts:30` `createCondenseQueue`, guardada via
  `setCondenseQueue`, `memory/registry.ts:35`, getter `getCondenseQueue()` `registry.ts:38`).
  BullMQ `Queue` com `.close()` — **nunca chamado**. ⚠️ **TAMBÉM compartilha `ctx.redis`**
  (`stages.ts:493` `createCondenseQueue(ctx.redis)`) — não só o eval worker. Como é um `Queue`
  (não `Worker`), BullMQ marca a conexão como `shared:true` e `queue.close()` **não** dá `.quit()`
  nela (verificado: `node_modules/bullmq/.../redis-connection.js:362` — `if (!extraOptions.shared)`
  gateia o `_client.quit()`); só `redis.quit()` no passo 2 fecha o cliente compartilhado. Seguro,
  mas o modelo de recursos do §8 risco 4 cobre **os dois** (eval worker + condense queue).

**Não-gap (correções à pesquisa, verificadas no código):**
- **O `WorkflowCleanupJob` setInterval NÃO segura o event loop.** A pesquisa sugeria que o timer
  (`workflow/cleanup.ts:25-31`) mantém o loop vivo e mascara o "graceful". **Falso:**
  `cleanup.ts:31` faz `this.timer.unref()` — o timer já é unref'd e não impede o exit natural.
  Ainda assim, fechá-lo é **higiene barata** (evita um tick de `tick()` correndo contra um
  pool/redis já fechado durante a janela de shutdown). Modelamos `cleanupJob?.stop()`
  (`cleanup.ts:34-36`) como close **opcional**, não como cura para o event loop.
- **O Worker principal do BullMQ NÃO precisa de novo close.** Sua conexão interna
  (`bullmq-consumer.ts:32`) é fechada por `worker.close()` via `stopConsumer()` (`shutdown.ts:25`),
  que já roda. Nada a fazer.

## §3. Goals & non-goals

**Goals:**
- **Threadar o `BootstrapContext` real** para `registerShutdownHandlers` — corrigir a ordem
  (`runBootstrap()` ANTES) e o argumento (`ctx` em vez de `{}`) em `src/index.ts:4-8`. Isto, por
  si, faz `redis.quit()`/`db.end()` (`shutdown.ts:50-59`) voltarem a rodar — fecha o **Gap 1**.
- **Ampliar `ShutdownResources`** (`shutdown.ts:14-17`) para modelar os 2 handles de
  ciclo-de-vida adicionais (eval worker, condense queue) + o cleanup job opcional, e adicionar
  o teardown **ordenado** entre o drain do worker e o close de redis/db.
- **Ordem de teardown correta e guardada**: drenar worker (`stopConsumer`) → close eval worker →
  close condense queue → stop cleanup timer → `redis.quit` → `db.end` → `exit(0)`. Cada novo
  close **guarded por `undefined`** (handles opt-in, ausentes na config default all-flags-off).
- **Idempotência de re-entrada**: flag `isShuttingDown` para que um 2º SIGTERM durante o
  shutdown não re-execute o teardown.
- **Watchdog de wall-clock** (forced `process.exit(1)` após N segundos) para que um close travado
  (redis half-open, worker preso em job) não bloqueie a terminação indefinidamente. ⚠️ O watchdog
  deve ser um **backstop de trava**, não um cortador de execução saudável: armado de forma a dar
  ao drain (`stopConsumer`) sua janela primeiro (ver risco 7 + OQ (e)), porque `exit(1)`
  mid-execução colide com o dedup-key e some com o `/complete` terminal.
- **Log estruturado de shutdown** (`event: "shutdown.graceful_complete" | "shutdown.forced_exit" |
  "shutdown.error"`) para que o stack de logs possa alertar sobre taxa de exit forçado sem precisar
  de camada de métricas (que não existe hoje) — ver OQ (f).
- **Cobrir BOOT-005**: 1º teste unit em `tests/unit/bootstrap/` (dir não existe hoje).

**Non-goals:**
- **NÃO** mover o registro de signal handlers para dentro do bootstrap (rejeita Opção C, §4.0).
  `index.ts` continua o orquestrador do lifecycle e o **único** dono dos signals.
- **NÃO** tocar `stopConsumer()`/`bullmq-consumer.ts` (drain já correto), `shutdownTracer`,
  `stopDevWsServer`, ou `McpClientRegistry.closeAll()`.
- **NÃO** transformar shutdown em framework de lifecycle. Reusar apenas `stop()`/`close()` já
  existentes.
- **NÃO** alterar o `WorkflowCleanupJob` (já `.unref()`'d). Só chamamos seu `stop()`.
- **NÃO** introduzir AbortController por execução (audit J8) — é entrega separada; este spec
  apenas deixa o ponto de extensão claro em §8.

## §4. Architecture proposal

### §4.0 Design options (a pesquisa apresentou 3; recomendação abaixo)

| Opção | O que faz | Prós | Contras |
|------|-----------|------|---------|
| **A. Reorder mínimo** | `index.ts`: `const ctx = await runBootstrap(); registerShutdownHandlers(ctx);` | Menor diff; conserta o finding literal; ramos `redis.quit`/`db.end` (`shutdown.ts:50-59`) voltam a rodar; usa os campos opcionais como projetado; trivialmente testável. | Fecha **só** db+redis. Deixa eval worker e condense queue **sem close algum**. Não amplia `ShutdownResources`. |
| **B. Reorder + ampliar `ShutdownResources`** ✅ | A + modelar eval worker / condense queue / cleanup job e fechá-los em ordem antes de redis/db. | Fecha **todos** os recursos na ordem correta. Reusa `stop()`/`close()` existentes + getters de registry já existentes (`getEvalWorker`, `getCondenseQueue`, `getWorkflowCleanupJob`). Sem subsistema novo. | Superfície maior: amplia `ShutdownResources` e adiciona imports de registry (acoplamento leve). Cada close precisa guard de `undefined` (handles opt-in). |
| **C. Bootstrap auto-registra handlers** | Mover `registerShutdownHandlers` para dentro de `runBootstrap()`. | Remove o footgun de ordem estruturalmente. `index.ts` encolhe. | Move registro de signals pro caminho de bootstrap → mais difícil de testar isolado; mistura responsabilidades; mudança conceitual maior que o finding pede; scope creep. |

**Recomendação: Opção B**, implementada como **superconjunto estrito de A**. A satisfaz o
BOOT-002 literal (reorder de `index.ts:5-6`); B é igualmente minimal e idiomática porque reusa
os métodos `stop()`/`close()` que **já existem** em cada handle e os getters de registry que
**já existem** — sem subsistema novo. **Rejeitamos C**: registrar signals dentro do bootstrap
reduz testabilidade e excede o escopo do finding. O founder pode rebaixar para **A** se quiser o
fix mais cirúrgico (mas A deixa eval worker + condense queue sem teardown — risco residual em
réplicas com `EVALS_WORKER_ENABLED`/`MEMORY_*` ligados).

### §4.1 `src/index.ts` — reorder (conserta Gap 1, ordem + argumento)

**Antes (`index.ts:4-8`):**
```typescript
const main = async (): Promise<void> => {
  registerShutdownHandlers({});
  await runBootstrap();
  console.log("Agent Harness is running");
};
```

**Depois:**
```typescript
const main = async (): Promise<void> => {
  const ctx = await runBootstrap();        // 1. recursos existem ANTES de registrar handlers
  registerShutdownHandlers({               // 2. threada os handles reais + getters de registry
    db: ctx.db,
    redis: ctx.redis,
    // handles opt-in puxados via getters de registry (undefined quando flag off):
    getEvalWorker,
    getCondenseQueue,
    getWorkflowCleanupJob,
  });
  console.log("Agent Harness is running");
};
```
> **Por que passar os getters e não os valores?** Os recursos opt-in são gravados nos registries
> **durante** as stages do bootstrap (eval worker no stage `start-evals`, condense queue no stage
> de memória, cleanup job em `start-workflow-resume` `stages.ts:589`). No instante de
> `registerShutdownHandlers` (pós-`runBootstrap`) eles já existem, mas passar os **getters** —
> avaliados lazy no momento do SIGTERM — é robusto a qualquer reordenação futura de stages e
> mantém `shutdown.ts` desacoplado dos call-sites de criação. (Alternativa: passar os valores
> resolvidos; trade-off discutido em §8 open question (b).)

### §4.2 `src/bootstrap/shutdown.ts` — ampliar `ShutdownResources` + teardown ordenado

**Antes (`shutdown.ts:14-17`):**
```typescript
export interface ShutdownResources {
  db?: Pool;
  redis?: Redis;
}
```

**Depois:**
```typescript
import type { Queue, Worker } from "bullmq";

export interface ShutdownResources {
  db?: Pool;
  redis?: Redis;
  /** Lazy getters — avaliados no instante do sinal; tudo opt-in / pode ser undefined. */
  getEvalWorker?: () => Worker | null | undefined;
  getCondenseQueue?: () => Queue | null | undefined;
  getWorkflowCleanupJob?: () => { stop(): void } | undefined;
  /** Watchdog: forced exit(1) após este wall-clock (default 10s). */
  forceExitAfterMs?: number;
}
```

**Teardown ordenado** — inserir os novos closes **entre** `shutdownTracer()` (`shutdown.ts:47`)
e o close de redis (`shutdown.ts:50`), preservando `stopConsumer()` em 1º (drain do worker) e
redis/db por último:

```typescript
let isShuttingDown = false;   // ← módulo-level guard de re-entrada (risco 2, §8)

export function registerShutdownHandlers(resources: ShutdownResources): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Shutdown already in progress — ignoring repeat signal");
      return;
    }
    isShuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");

    // Watchdog: se algum close travar, força exit(1) (orquestrador acabaria mandando SIGKILL).
    // event:"shutdown.forced_exit" é o campo discriminável para alerta de taxa (OQ (f)).
    const forceMs = resources.forceExitAfterMs ?? 10_000;
    const watchdog = setTimeout(() => {
      logger.error(
        { event: "shutdown.forced_exit", signal, forceMs },
        "Shutdown timed out — forcing exit(1)",
      );
      process.exit(1);
    }, forceMs);
    watchdog.unref();   // não segura o event loop por si só

    try {
      // 1. Drenar o BullMQ Worker principal (espera jobs in-flight). JÁ EXISTIA.
      await stopConsumer();

      // 1a/1a'/1b. dev-ws / MCP / tracer — JÁ EXISTIAM (guarded). [shutdown.ts:28-47]

      // 1c. Fechar eval worker (BullMQ Worker). Guard p/ flag off.
      //     ⚠️ COMPARTILHA ctx.redis (stages.ts:564) — fechar ANTES de redis.quit.
      //     Mecânica (verificada na fonte do BullMQ 5.76):
      //       - conexão de COMANDO: shared:true (queue-base.js:38 isRedisInstance) ⇒
      //         worker.close() NÃO dá .quit() em ctx.redis (redis-connection.js:362).
      //       - conexão BLOQUEANTE: o worker faz ctx.redis.duplicate() (worker.js:120-130)
      //         e a marca shared:false ⇒ worker.close() FECHA esse duplicado (que ele criou,
      //         não é ctx.redis). Logo nenhum double-quit de ctx.redis. Ordem segura
      //         (ver §8 risco 4 p/ a mecânica correta).
      try {
        const evalWorker = resources.getEvalWorker?.();
        if (evalWorker) {
          logger.info("Closing eval worker");
          await evalWorker.close();
        }
      } catch (err) {
        logger.warn({ err }, "Error closing eval worker (continuing)");
      }

      // 1d. Fechar condense queue (BullMQ Queue). Guard p/ flag off.
      try {
        const condenseQueue = resources.getCondenseQueue?.();
        if (condenseQueue) {
          logger.info("Closing condense queue");
          await condenseQueue.close();
        }
      } catch (err) {
        logger.warn({ err }, "Error closing condense queue (continuing)");
      }

      // 1e. Parar o timer do workflow cleanup (já unref'd; stop p/ higiene). Guard p/ flag off.
      try {
        resources.getWorkflowCleanupJob?.()?.stop();
      } catch (err) {
        logger.warn({ err }, "Error stopping workflow cleanup job (continuing)");
      }

      // 2. Fechar Redis (cliente de bootstrap). JÁ EXISTIA [shutdown.ts:50-53].
      if (resources.redis) {
        logger.info("Closing Redis connection");
        await resources.redis.quit();
      }

      // 3. Fechar DB pool. JÁ EXISTIA [shutdown.ts:56-59].
      if (resources.db) {
        logger.info("Closing DB pool");
        await resources.db.end();
      }

      clearTimeout(watchdog);
      // event:"shutdown.graceful_complete" — par do forced_exit p/ o SLI de OQ (f).
      logger.info({ event: "shutdown.graceful_complete", signal }, "Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(watchdog);
      logger.error({ event: "shutdown.error", signal, err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));   // [shutdown.ts:69]
  process.on("SIGINT", () => void shutdown("SIGINT"));     // [shutdown.ts:70]
}
```

> **Ordem é load-bearing (§8 risco 3):** o worker é drenado **primeiro** (`stopConsumer`, que
> espera jobs ativos via `worker.close()`), de modo que nenhum `handleExecution` em voo perca seu
> `ctx.db`/`ctx.redis` no meio de um callback. eval-worker/condense-queue/cleanup ficam **entre**
> o drain e o close de redis/db. redis/db são **sempre os últimos**.

### §4.3 Por que NÃO mudamos `bullmq-consumer.ts` nem o cleanup job

- `stopConsumer()` (`bullmq-consumer.ts:45-51`) já faz `worker.close()` (drain) e zera
  `activeWorker`. Intacto.
- `WorkflowCleanupJob.stop()` (`cleanup.ts:34-36`) já existe e o timer já é `.unref()`'d
  (`cleanup.ts:31`). Só o **chamamos**; não o alteramos.

## §5. Implementation plan

### Phase 1 — Cablar handles reais + ampliar teardown (~2h)

**Files:**
- `src/index.ts:4-8` — reorder: `const ctx = await runBootstrap()` **antes**;
  `registerShutdownHandlers({ db: ctx.db, redis: ctx.redis, getEvalWorker, getCondenseQueue, getWorkflowCleanupJob })`.
  Imports: `getEvalWorker` de `./evals/registry.js`, `getCondenseQueue` de `./memory/registry.js`,
  `getWorkflowCleanupJob` de `./bootstrap/stages.js`.
- `src/bootstrap/shutdown.ts:14-17` — ampliar `ShutdownResources` (eval worker getter, condense
  queue getter, cleanup job getter, `forceExitAfterMs`).
- `src/bootstrap/shutdown.ts:19-71` — flag `isShuttingDown`; watchdog `setTimeout(...).unref()`;
  closes 1c/1d/1e guarded entre `shutdownTracer()` (`:47`) e o redis-close (`:50`);
  `clearTimeout(watchdog)` nos dois caminhos de saída.

**Result:** SIGTERM/SIGINT fecham pool pg + ioredis de bootstrap (Gap 1) + eval worker + condense
queue + cleanup timer (Gap 2), em ordem, com watchdog e guard de re-entrada.

### Phase 2 — Testes (cobre BOOT-005) (~1.5h)

**Files (criar dir `tests/unit/bootstrap/`):**
- `tests/unit/bootstrap/shutdown.test.ts` — **NEW** (dir não existe; `vitest.config.ts:8`
  `include: ['tests/**/*.test.ts']` já pega).

**Mocks necessários** (o util importa no topo `getHarnessConfig()` `shutdown.ts:11`,
`stopConsumer`/`stopDevWsServer`/`McpClientRegistry`/`shutdownTracer`):
```typescript
vi.mock("../../../src/integration/bullmq-consumer.js", () => ({ stopConsumer: vi.fn() }));
vi.mock("../../../src/dev/ws-server.js", () => ({ stopDevWsServer: vi.fn() }));
vi.mock("../../../src/mcp/client-registry.js", () => ({
  McpClientRegistry: { getInstance: () => ({ closeAll: vi.fn() }) },
}));
vi.mock("../../../src/observability/tracer.js", () => ({ shutdownTracer: vi.fn() }));
// process.exit: stub p/ não matar o runner; registra o código e lança p/ encerrar o shutdown().
const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
  throw new ExitError(code ?? 0);
}) as never);
```

**Casos:**
1. **db+redis fecham + ordem.** `registerShutdownHandlers({ db: fakeDb, redis: fakeRedis })`,
   `process.emit("SIGTERM")` (await microtask), asserts: `stopConsumer` chamado, depois
   `fakeRedis.quit`, depois `fakeDb.end`; `exit(0)`.
2. **Handles opt-in fecham quando presentes.** getters retornando spies de eval worker
   (`.close`), condense queue (`.close`), cleanup job (`.stop`) → todos disparam, **antes** de
   `redis.quit`.
3. **Handles opt-in ausentes não quebram.** getters retornando `undefined` (config default
   all-flags-off) → nenhum throw; redis/db ainda fecham; `exit(0)`.
4. **Re-entrada.** Emitir SIGTERM duas vezes → `stopConsumer`/`quit`/`end` chamados **uma só
   vez** (flag `isShuttingDown`).
5. **Watchdog.** `forceExitAfterMs: 50` + `stopConsumer` que nunca resolve (fake timers) →
   `exit(1)` após o timeout.
6. **Erro num close → exit(1).** `fakeDb.end` rejeita → `exit(1)`, watchdog limpo.
7. **`ctx.redis.quit` chamado EXATAMENTE uma vez** (trava o invariante de risco 4 contra upgrades
   de BullMQ). Com eval worker + condense queue presentes (ambos compartilhando o mesmo fake
   `redis`), asserir que `fakeRedis.quit` foi chamado **1×** (só pelo passo 2), **não** pelos
   `evalWorker.close()`/`condenseQueue.close()`.
8. **Watchdog emite `event:"shutdown.forced_exit"`** (caminho de timeout) e o caminho feliz emite
   `event:"shutdown.graceful_complete"` — asserir nos logs (spy no logger) para garantir o campo
   discriminável que alimenta o alerta de OQ (f).

**Integration (opcional, gated `RUN_INTEGRATION=1`** — padrão `bullmq-consumer.integration.test.ts:8`
`describe.skipIf`): boot de um Worker real contra Redis de teste, SIGTERM, assert que
`worker.close()` drenou um job in-flight e conexões fecharam. Secundário ao unit.

## §6. Testing strategy

### Unit (cobertura primária — fecha BOOT-005)
- `tests/unit/bootstrap/shutdown.test.ts` (NEW). Sem IO real: mock de
  `getHarnessConfig`/`stopConsumer`/`stopDevWsServer`/`McpClientRegistry`/`shutdownTracer`;
  `process.exit` stubbed (`ExitError`). Fakes de `Pool` (`.end` spy) e `Redis` (`.quit` spy).
- Asserts de **ordem** via `vi.fn` call-order (`.mock.invocationCallOrder`): drain →
  evalWorker.close → condenseQueue.close → cleanup.stop → redis.quit → db.end.
- Guard de `undefined`, re-entrada, watchdog, e exit-code (0 sucesso / 1 erro|timeout).

### Integration (opcional, secundário)
- Worker real + Redis de teste; SIGTERM drena job in-flight; conexões fecham.

### Regression
- Boot/run normal inalterado: `runBootstrap()` ainda retorna `ctx` e o harness loga
  "is running". Stages opt-in (evals, memória, workflow-resume) inalterados.
- Caminho all-flags-off (config default): getters retornam `undefined`; shutdown fecha só
  redis+db; nenhum NPE.

## §7. Migration & rollback

**Sem migração de dados** — mudança puramente de runtime/lifecycle. Sem migrations Postgres,
sem mudança de payload, sem mudança de contrato de callback.

**Ativação:**
- Phase 1 muda o comportamento de shutdown imediatamente: SIGTERM/SIGINT passam a fechar
  pool+redis (+ eval worker/condense queue/cleanup quando ligados). Observável apenas no caminho
  de terminação — sem efeito no hot path de execução.
- Em prod (2 réplicas Hetzner), o orquestrador manda SIGTERM no rolling-update; o harness agora
  drena + libera conexões em vez de vazar até o SIGKILL. Reduz conexões pg/Redis órfãs durante
  redeploys.

**Rollback:** reverter `index.ts` + `shutdown.ts` para o status quo (`registerShutdownHandlers({})`).
Não-destrutivo — volta ao comportamento atual (vaza conexões no shutdown, OS reapeia). Nenhum
estado persistente afetado.

**Feature flag:** desnecessária. O `forceExitAfterMs` é configurável no call-site.
⚠️ **O default de 10s NÃO é conservador o suficiente** dado o hot path: o surface loop recebe
~50% de `HARNESS_MAX_EXECUTION_TIME_MS` (default 120 000 ⇒ até ~60s) e execuções LLM-driven
rotineiramente passam de 10s. Um watchdog de 10s **dispararia mid-execução** com frequência →
risco 7. **Recomendação:** default ≥ (p99 de execução + folga) **e** ≤ `terminationGracePeriod`
do orquestrador; um ponto de partida sensato é `HARNESS_MAX_EXECUTION_TIME_MS` + margem (não 10s),
ou — melhor — separar `drainGraceMs` (espera o drain) do `forceExitAfterMs` (backstop de trava),
per OQ (e). O número final é decisão operacional do founder (OQ (a)).

## §8. Risks & open questions

### Risks
1. **Watchdog vs. drain longo.** Se um job in-flight legítimo demorar mais que `forceExitAfterMs`
   (10s), o watchdog força `exit(1)` no meio do drain → BullMQ marcará o job como stalled e
   redelivará. Mitigar: alinhar `forceExitAfterMs` ao `terminationGracePeriod` do orquestrador
   (deixar folga). ⚠️ **A "cobertura de stalled-job do BullMQ" não é gratuita aqui** — ver risco 7:
   redeliver bate no dedup-wall e a execução **some sem callback terminal**. Além disso, com o
   default `maxStalledCount: 1` (o `startConsumer` em `bullmq-consumer.ts:31-33` **não** sobrescreve),
   um job que estala **2×** vai pra `failed`, não é redelivado indefinidamente. O watchdog deve ser
   **conservador** (folga ampla) justamente porque cada `exit(1)` mid-drain custa caro.
2. **Re-entrada por 2º sinal.** Sem guard, um 2º SIGTERM durante o shutdown re-executaria
   `stopConsumer`/quit/end (handlers não são de-registrados). Mitigado pela flag módulo-level
   `isShuttingDown`.
3. **Ordem (load-bearing).** Drenar o Worker (`stopConsumer`, que espera jobs ativos) **antes**
   de fechar pg `Pool`/ioredis, ou um `handleExecution` em voo perde DB/Redis no meio de um
   callback. O util já chama `stopConsumer()` em 1º (`shutdown.ts:25`); preservamos isso e
   inserimos os novos closes **entre** o drain e redis/db.
4. **Redis compartilhado (eval worker + condense queue).** O Worker principal **possui** sua
   conexão (`bullmq-consumer.ts:32` passa `{ url }`, não uma instância — fechada por
   `worker.close()` via `stopConsumer`). O **eval worker** (`stages.ts:564` `connection: ctx.redis`)
   **e a condense queue** (`stages.ts:493` `createCondenseQueue(ctx.redis)`) compartilham `ctx.redis`.
   **Mecânica precisa (verificada na fonte do BullMQ 5.76 — corrige a afirmação imprecisa da
   pesquisa):**
   - `RedisConnection.close()` só dá `_client.quit()` **se a conexão não for `shared`**
     (`redis-connection.js:351-372`, gate `if (!this.extraOptions.shared)` em `:362`).
   - Quando uma **instância** ioredis é passada como `connection`, `QueueBase`/`Worker` marcam a
     conexão de **comando** como `shared: isRedisInstance(opts.connection)` ⇒ `true`
     (`queue-base.js:38`). Logo `evalWorker.close()` / `condenseQueue.close()` **não** dão `.quit()`
     em `ctx.redis`. ✔ seguro.
   - **Porém** o `Worker` (não o `Queue`) cria uma conexão **bloqueante separada** via
     `ctx.redis.duplicate(...)` marcada `shared: false` (`worker.js:120-130`). `worker.close()`
     **fecha esse duplicado** — mas é um socket que o worker criou, **não** `ctx.redis`. Logo ainda
     não há double-quit de `ctx.redis`. (A redação anterior "`Worker.close()` não fecha conexão
     injetada" estava direcionalmente certa para a conexão de comando, mas mecanicamente imprecisa:
     o worker SIM fecha o duplicado bloqueante que ele mesmo criou.)
   Conclusão inalterada: `evalWorker.close()`/`condenseQueue.close()` antes de `resources.redis.quit()`
   é **seguro**; só `redis.quit()` no passo 2 fecha o cliente compartilhado. Risco residual: se uma
   versão futura do BullMQ mudar o gate `shared`, o teste de ordem (§6) e o guard de erro pegam.
   Mitigação adicional barata: o teste unit deve **asseverar** que `ctx.redis.quit` é chamado
   **exatamente uma vez** (não pelos closes intermediários) — trava o invariante contra upgrades.
5. **Feature-flag gating.** Eval worker, condense queue, semantic recall, dev-ws, MCP, RAG são
   opt-in; cada novo close é **guarded por `undefined`** (getter `?.()` + check), evitando NPE no
   caminho comum (todas as flags off).
6. **Disciplina minimal-change.** Resistir a transformar isto num framework de lifecycle —
   reusar só `stop()`/`close()` existentes. Spec rejeita Opção C por isso.
7. **⚠️ CRÍTICO — Watchdog `exit(1)` mid-execução colide com o dedup-wall → execução some sem
   callback terminal.** O `handleExecution` faz `SET harness:dedup:{execution_id} EX 3600 NX`
   **no início** (`execution-handler.ts:852-862`) e, se a chave já existe, faz `return;` **sem
   `sendComplete`** (`:858-861`). Sequência venenosa: SIGTERM chega com uma execução no passo 9;
   o drain não termina em `forceExitAfterMs`; o watchdog força `exit(1)` **depois** do dedup-set
   mas **antes** do `sendComplete`. BullMQ redeliva o job stalled; no replay, o `SET NX` retorna
   `null` → "Duplicate execution — skipping" → **nenhum `/complete` é emitido jamais**. O backend
   deixa a execução pendurada em "running" até **seu próprio** timeout (J5 do audit: "/complete no
   caminho de falha é best-effort — execução pode sumir sem o backend saber"). O guard de
   "replied-marker" (`:355-370`) é Model-C-específico **e fica atrás** do dedup-check, então não
   salva. **Este é um modo de falha que o watchdog INTRODUZ** — não existia antes do spec.
   **Mitigações (founder decide qual — ver OQ (e)):**
   (i) **Drenar antes de armar o watchdog fatal.** Dar ao `stopConsumer()` (drain real, espera
   jobs ativos) uma janela dedicada `drainGraceMs` *separada* do watchdog; só armar o `exit(1)`
   forçado **depois** do drain ter tido sua chance — assim o caminho feliz (job termina e emite
   `/complete`) não é cortado. O watchdog cobre só travas reais (redis half-open, close preso).
   (ii) **Não usar TTL longo no dedup** quando a intenção é dedup de *retry idempotente*: hoje o
   `EX 3600` transforma "retry legítimo de job stalled" em "duplicata silenciosa". O fix correto
   é fora deste spec (pertence ao handler/idempotency), mas o spec **deve** documentar a colisão
   para não anunciar BOOT-002 como "fechado sem regressões".
   (iii) **Aceitar a perda conscientemente**: alinhar `forceExitAfterMs` >> p99 de execução +
   `terminationGracePeriod` do orquestrador, de modo que o watchdog praticamente nunca dispare
   mid-execução. Mais barato, mas só reduz a probabilidade, não elimina.
8. **Sem callback terminal nem audit row em NENHUM caminho de shutdown.** Mesmo no caminho
   **feliz** (drain completo via `worker.close()`), uma execução que estava in-flight e foi
   **interrompida** pelo close não emite `/complete` próprio — `worker.close()` espera o handler
   **terminar naturalmente** (e ele emite o seu `/complete`), então o caminho feliz está OK; mas
   se o handler lança/é cortado, nada emite o callback terminal. Não há DLQ no `src/` (confirmado:
   audit J3 "sem retry, sem DLQ, sem callback") e não há camada de métricas (`src/observability/`
   não expõe counter/gauge). **Consequência operacional:** o spec adiciona um caminho de
   `exit(1)` (watchdog) e um caminho de `exit(0)`/`exit(1)` por sinal, mas **sem nenhuma
   observabilidade** sobre quantas vezes o shutdown forçado dispara ou quantas execuções foram
   cortadas. Ver OQ (f) — SLO/alerta.

### Open questions
1. **(a) Watchdog agora ou depois?** Relacionado ao audit **J8** (sem wall-clock global por
   execução). Recomendação: incluir o watchdog **agora** (barato, 1 `setTimeout().unref()`),
   pois shutdown sem fallback de timeout é um risco operacional real em rolling-updates. O founder
   pode rebaixar para "sem watchdog" se quiser o fix mínimo absoluto (Opção A pura).
2. **(b) Getters de registry vs. valores resolvidos.** Passar **getters** (`getEvalWorker`, …)
   mantém `shutdown.ts` desacoplado dos call-sites de criação e é robusto a reordenação de stages;
   custa 3 imports no `index.ts`. Alternativa: resolver os valores em `index.ts` e passá-los —
   `shutdown.ts` 100% desacoplado de registries, mas captura snapshot no momento do registro (OK
   hoje, pois é pós-bootstrap). Recomendação: **getters** (lazy, à prova de futuro). Founder
   decide.
3. **(c) AbortController por execução (J8).** Quando/se J8 landar, o drain pode abortar execuções
   em voo ao invés de esperá-las até o grace period. Este spec deixa o ponto de extensão claro
   (entre `stopConsumer` e o watchdog) mas **não** o implementa — entrega separada.
4. **(d) Prioridade do drain perfeito.** As 2 réplicas Hetzner dependem da recuperação de
   stalled-job do BullMQ; drain imperfeito **não perde o job** (é redelivado), **mas** o redeliver
   bate no dedup-wall (risco 7) e a execução vira duplicata silenciosa **sem `/complete`**. Logo o
   drain perfeito é **mais** crítico do que a pesquisa sugeria, não menos. **Correção à pesquisa:**
   "job redelivado ⇒ trabalho não perdido" é verdade só para o *job BullMQ*; o *contrato de
   execução com o backend* (callback terminal) **é** perdido. Reforça armar o watchdog só após o
   drain ter sua janela (OQ (e)/(a)).
5. **(e) ⚠️ Como fechar a colisão watchdog × dedup (risco 7)?** Três opções no risco 7:
   (i) janela `drainGraceMs` dedicada antes do `exit(1)` fatal; (ii) repensar o TTL/semântica do
   dedup-key (fora deste spec, mas precisa de dono); (iii) só tunar `forceExitAfterMs` alto e
   aceitar a cauda. **Recomendação SRE:** (i) **agora** (barato, contém o blast-radius dentro deste
   spec — o watchdog passa a ser estritamente um backstop de trava, não um cortador de execução
   saudável) **+** registrar (ii) como follow-up explícito no handler/idempotency. **Não** anunciar
   BOOT-002 como "fechado sem regressões" sem (i) ou (iii) decidido. Founder decide.
6. **(f) Observabilidade/SLO do shutdown — há métrica/alerta?** Hoje **não há** camada de métricas
   nem DLQ. Recomendação SRE (mínimo viável, sem virar "subsistema"): emitir log **estruturado** em
   `level:warn`/`error` com um campo discriminável (`event: "shutdown.forced_exit"` no watchdog;
   `event: "shutdown.graceful_complete"` no caminho feliz; contagem de jobs ativos no instante do
   sinal, se `getActiveWorker()` expuser) — assim o stack de logs (Pino → coletor) consegue um
   **alerta sobre taxa de `forced_exit`** e um proxy de "execuções cortadas" sem precisar de
   Prometheus. SLI candidato pós-go-live: *fração de shutdowns que completam graciosamente dentro
   de `forceExitAfterMs`* (alvo ex. 99%); *taxa de `exit(1)` forçado por redeploy*. Alerta sobre
   **profundidade de stalled/failed jobs** na fila principal (proxy do dead-letter inexistente) é o
   item de maior alavancagem, mas depende de instrumentar a fila — follow-up separado, fora deste
   spec. Founder decide o quanto entra agora.

## §9. Definition of done

- [ ] **Phase 1:**
  - [ ] `src/index.ts` — `const ctx = await runBootstrap()` ANTES; `registerShutdownHandlers`
        recebe `{ db, redis, getEvalWorker, getCondenseQueue, getWorkflowCleanupJob }`.
  - [ ] `src/bootstrap/shutdown.ts` — `ShutdownResources` ampliado; flag `isShuttingDown`;
        watchdog `setTimeout().unref()` + `clearTimeout` nos dois exits; closes 1c/1d/1e guarded
        entre `shutdownTracer()` e o redis-close; ordem preservada.
  - [ ] `npm run build` limpo (sem novos warnings); `npm run lint` limpo.
- [ ] **Phase 2:**
  - [ ] `tests/unit/bootstrap/shutdown.test.ts` (NEW) — db+redis fecham em ordem; opt-in fecham
        quando presentes / skip quando undefined; re-entrada single-fire; watchdog → exit(1);
        erro → exit(1).
  - [ ] Suite verde (`npm run test`); 1ª cobertura em `src/bootstrap/*` (mitiga BOOT-005).
- [ ] Audit finding **BOOT-002** validado como closed (SIGTERM/SIGINT fecham pool + redis +
      drenam worker + fecham eval worker/condense queue/cleanup).
- [ ] **Decisão registrada para OQ (e)** (colisão watchdog × dedup, risco 7) — BOOT-002 NÃO é
      anunciado "fechado sem regressões" sem (i) janela de drain dedicada antes do `exit(1)` fatal,
      ou (iii) `forceExitAfterMs` conservador documentado. O modo de falha do risco 7 deve estar
      mitigado ou explicitamente aceito pelo founder, não silenciado.
- [ ] **Log estruturado de shutdown** (`event:` discriminável) presente nos 3 caminhos
      (graceful/forced/error), com teste asserindo os campos (OQ (f)).
- [ ] Sem regressões no boot/run normal. **Em particular:** o caminho feliz (drain completo)
      continua deixando cada `handleExecution` emitir seu próprio `/complete` — o shutdown **não**
      corta uma execução que terminaria sozinha dentro da janela de drain.
- [ ] Code review aprovado (cablagem + ordem de teardown + testes).

## §10. References

- **Audit finding:** `docs/audits/runtime-gap-audit-2026-06-02.md:259-261` (BOOT-002 — "shutdown
  nunca fecha DB pool nem Redis — index.ts passa registerShutdownHandlers({}) vazio"); mesma seção
  cita BOOT-005 (cobertura ZERO em `src/bootstrap/*`).
- **Código fonte (verificado):**
  - `src/index.ts:4-8` (call-site defeituoso — `registerShutdownHandlers({})` em `:5`, contexto
    de `runBootstrap()` descartado em `:6`).
  - `src/bootstrap/runner.ts:13-36` (cria `db`=`new Pool` `:16`, `redis`=`new Redis` `:17`,
    `await redis.connect()` `:18`, `BootstrapContext {db,redis}` `:20`, `return ctx` `:35`).
  - `src/bootstrap/stages.ts:65-68` (`BootstrapContext { db: Pool; redis: Redis }`); `:84-86`
    (`getWorkflowCleanupJob()`); `:564` (eval worker recebe `connection: ctx.redis` — SHARED);
    `:589` (`_workflowCleanupJob?.start()`).
  - `src/bootstrap/shutdown.ts:11` (`getHarnessConfig()` no topo); `:14-17` (`ShutdownResources`
    `{db?,redis?}`); `:19-71` (`registerShutdownHandlers`/`shutdown`); `:25` (`stopConsumer` 1º);
    `:28-47` (dev-ws/MCP/tracer guarded); `:50-53` (`redis.quit` guarded); `:56-59`
    (`db.end` guarded); `:62`/`:65` (`exit(0)`/`exit(1)`); `:69-70` (`process.on SIGTERM/SIGINT`).
  - `src/integration/bullmq-consumer.ts:32` (Worker principal cria conexão Redis interna a partir
    de `config.redis.url`); `:45-51` (`stopConsumer` → `worker.close()` em `:48`, drain).
  - `src/evals/eval-worker.ts:24` (`startEvalWorker` → BullMQ `Worker`); `src/evals/registry.ts:23`
    (`setEvalWorker`), `:26` (`getEvalWorker`).
  - `src/integration/condense-queue.ts:30` (`createCondenseQueue` → BullMQ `Queue`);
    `src/memory/registry.ts:35` (`setCondenseQueue`), `:38` (`getCondenseQueue`).
  - `src/workflow/cleanup.ts:25-31` (`start()` — timer já `.unref()`'d em `:31`); `:34-36`
    (`stop()` → `clearInterval`).
- **Test infra:** `vitest.config.ts:7-8` (`setupFiles: ['./tests/setup.ts']`,
  `include: ['tests/**/*.test.ts']`); `tests/integration/bullmq-consumer.integration.test.ts:8`
  (gate `RUN_INTEGRATION==='1'` + `describe.skipIf`).
- **Dedup / callback terminal (risco 7, verificado):**
  - `src/runtime/execution-handler.ts:852-862` — `SET harness:dedup:{execution_id} EX 3600 NX`
    no início; `if (acquired === null) { ...; return; }` em `:858-861` **sem `sendComplete`**.
  - `src/runtime/execution-handler.ts:355-370` — guard "replied-marker" é Model-C-específico e
    fica **atrás** do dedup-check (não cobre o caso geral).
  - `docs/audits/runtime-gap-audit-2026-06-02.md:272-274` — J3 (payload inválido descartado sem
    DLQ/callback) + J5 (/complete no caminho de falha é best-effort; execução pode sumir).
- **BullMQ shared-connection (risco 4, verificado na fonte instalada `bullmq@5.76.9`):**
  - `node_modules/bullmq/dist/cjs/classes/redis-connection.js:351-372` — `close()` só dá
    `_client.quit()` se `!this.extraOptions.shared` (`:362`).
  - `node_modules/bullmq/.../queue-base.js:37-42` — `shared: isRedisInstance(opts.connection)`
    (instância ⇒ `shared:true` ⇒ não fecha).
  - `node_modules/bullmq/.../worker.js:120-130` — conexão **bloqueante** = `connection.duplicate()`
    com `shared:false` ⇒ `worker.close()` fecha o **duplicado** (criado pelo worker), não `ctx.redis`.
  - `src/bootstrap/stages.ts:493` — condense queue **também** recebe `ctx.redis` (`createCondenseQueue(ctx.redis)`).
- **Observabilidade (OQ (f), verificado):** `src/observability/` não expõe counter/gauge/DLQ;
  só tracing (OTel) + logging Pino. Alerta de shutdown depende de log estruturado, não de métrica.
- **Correções à pesquisa (verificadas):**
  - O `WorkflowCleanupJob` setInterval **NÃO** segura o event loop — `cleanup.ts:31` faz
    `this.timer.unref()`. Logo `stop()` é higiene, não cura de event-loop.
  - O eval worker **e a condense queue COMPARTILHAM** `ctx.redis` (`stages.ts:564` e `:493`) — ver
    §8 risco 4 para a mecânica precisa (`shared:true` na conexão de comando) e a ordem segura de close.
  - "`Worker.close()` não fecha conexão injetada" da pesquisa estava **mecanicamente imprecisa**:
    o worker fecha o duplicado **bloqueante** que ele mesmo cria (`worker.js:120-130`), só não
    fecha a conexão de **comando** compartilhada. Resultado (sem double-quit de `ctx.redis`) é o
    mesmo, mas a razão correta está no risco 4.
- **Specs relacionadas:** entregas de audit irmãs em `docs/superpowers/specs/` (idempotency-key,
  context-builder, mutation-tool-unification) — mesma onda 2026-06-02; J8 (wall-clock por
  execução) é follow-up separado referenciado em §8 OQ (c).
