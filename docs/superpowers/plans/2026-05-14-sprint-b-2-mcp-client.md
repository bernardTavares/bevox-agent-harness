# Sprint B.2: MCP Client (consumir MCP servers externos como skills)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Permitir que o harness conecte-se a **MCP servers externos** (filesystem, GitHub, Slack, Linear, servidores custom de parceiros) e exponha as tools desses servidores aos surface agents como se fossem skills nativas. Cada tool MCP remota é registrada no `SkillRegistry` existente com prefixo `mcp:<server>.` — reaproveitando reasoning engines, context builder e permission evaluator sem alterações estruturais.

**Architecture:** No bootstrap (após carga das skills built-in, mas antes do consumer BullMQ), um `McpClientRegistry` lê a config de servidores remotos, instancia um `Client` MCP por servidor (transport stdio para processos locais spawned, ou SSE/HTTP para remotos), invoca `tools/list`, e adapta cada tool em um `LoadedSkill` sintético via `McpToolAdapter`. Esses skills sintéticos entram no mesmo `SkillRegistry` que as built-in — reasoning engines, evaluator e context builder não distinguem entre uma skill local e uma proxiada via MCP.

**Tech Stack:** `@modelcontextprotocol/sdk` (mesma dependência do B.1 — coordenar versão), `ajv` para validar `inputSchema` retornado por servidores (não confiar cegamente), `p-timeout` para timeouts por chamada. Config em arquivo JSON (`mcp.config.json`) **OU** env var `MCP_SERVERS_CONFIG` (caminho do arquivo) com schema Zod.

**⚠ Princípio de design crítico:** MCP tools externas são **untrusted by default**. Entram no mesmo evaluator de 3 camadas e respeitam `denied list` e `agentType`. O prefixo `mcp:` é semântico (telemetria, debugging) — segurança vem do evaluator, NÃO do prefixo.

---

## Dependencies

- **Hard:** Fase 8 (`SkillRegistry` existe e aceita `LoadedSkill`).
- **Soft:** Fase 3 (permission evaluator estável); Sprint B.1 **não é** hard-dependency, mas compartilha `@modelcontextprotocol/sdk` — recomendado mergear B.1 primeiro para travar versão.
- **Blocks:** Nada.
- **⚠ Não substituir** o LLM Gateway, reasoning engines ou permission evaluator. MCP client é **adicionalmente** plugado em cima do registry.

## Files Touched

### Create
- `src/mcp/client.ts` — wrapper sobre o `Client` do SDK, com lifecycle gerenciado
- `src/mcp/client-registry.ts` — singleton (`McpClientRegistry`) que mantém connections ativas
- `src/mcp/mcp-tool-adapter.ts` — converte `MCP Tool` (do `tools/list`) em `LoadedSkill`
- `src/mcp/client-config.schema.ts` — Zod schema do `mcp.config.json`
- `src/mcp/transports/client-stdio.ts` — wrapper de `StdioClientTransport` (spawn process)
- `src/mcp/transports/client-sse.ts` — wrapper de `SSEClientTransport`
- `src/mcp/health.ts` — health check (ping periódico, dead connection eviction)
- `src/config/mcp-servers.ts` — loader de config (arquivo OU env)
- `tests/unit/mcp/mcp-tool-adapter.test.ts`
- `tests/unit/mcp/client-config.test.ts`
- `tests/integration/mcp-client.test.ts` (sobe servidor fake via SDK, conecta cliente, valida registro de skill)
- `docs/architecture/mcp-client.md`
- `docs/runbooks/mcp-add-external-server.md`
- `examples/mcp.config.example.json`

### Modify
- `package.json` — `@modelcontextprotocol/sdk` (mesma versão de B.1), `ajv`, `p-timeout`
- `src/config/env.ts` — `MCP_SERVERS_CONFIG_PATH`, `MCP_CLIENT_TIMEOUT_MS`, `MCP_CLIENT_ENABLED`
- `src/bootstrap/stages.ts` — novo estágio `loadMcpClientsStage` após `loadSkillsStage` (stage 5.5)
- `src/skills/skill-registry.ts` — **NÃO modificar interface**; apenas validar que aceita prefixo `mcp:` (regex já permite via Task 1 do F8: `^[a-z][a-z0-9-]*$` — **CONFLITO**, ver Task 3 abaixo)
- `src/permissions/evaluator.ts` — **NÃO modificar**; MCP skills entram pelo mesmo path
- `README.md` — seção "Conectar a MCP server externo"

### High-conflict files
- ⚠️ `package.json` — coordenar com B.1
- ⚠️ `src/skills/skill-manifest.schema.ts` — regex do `name` precisa permitir prefixo `mcp:` (`:` não estava no charset)
- ⚠️ `src/bootstrap/stages.ts` — adicionar estágio entre o existente e o consumer

## Estimated Effort
1.5 semanas (~40-50 horas).

---

## Tasks

### Task 1: Schema de config + loader

**Files:**
- Create: `src/mcp/client-config.schema.ts`
- Create: `src/config/mcp-servers.ts`
- Create: `examples/mcp.config.example.json`
- Create: `tests/unit/mcp/client-config.test.ts`

- [ ] **Step 1: Schema Zod**

```typescript
import { z } from "zod";

const stdioServer = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
});

const sseServer = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const serverEntry = z.discriminatedUnion("transport", [stdioServer, sseServer]);

export const mcpClientConfigSchema = z.object({
  servers: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "server id: lowercase, [a-z0-9-], max 32"),
    serverEntry,
  ),
  defaults: z.object({
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
    enabledByDefault: z.boolean().default(true),
  }).default({ timeoutMs: 10000, enabledByDefault: true }),
}).strict();

export type McpClientConfig = z.infer<typeof mcpClientConfigSchema>;
```

- [ ] **Step 2: Loader (arquivo OU env)**

```typescript
import { readFile } from "node:fs/promises";
import { mcpClientConfigSchema, type McpClientConfig } from "../mcp/client-config.schema";
import { getEnv } from "./env";

export async function loadMcpClientConfig(): Promise<McpClientConfig | null> {
  const env = getEnv();
  if (!env.MCP_CLIENT_ENABLED) return null;
  const path = env.MCP_SERVERS_CONFIG_PATH;
  if (!path) return null;
  const raw = await readFile(path, "utf8");
  const json = JSON.parse(raw);
  return mcpClientConfigSchema.parse(json);
}
```

- [ ] **Step 3: `examples/mcp.config.example.json`**

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/bevox-fs"]
    },
    "github": {
      "transport": "sse",
      "url": "https://mcp.github.example.com/sse",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" }
    }
  },
  "defaults": { "timeoutMs": 15000, "enabledByDefault": true }
}
```

⚠ Interpolação `${VAR}` nos `headers` e `env` **deve ser feita no loader** (não pelo SDK). Implementar substituição simples antes de passar ao SDK; documentar que apenas `${ENV_VAR}` é suportado (sem expressões).

- [ ] **Step 4: Testes Zod**

```typescript
it("rejects unknown transport", () => {
  expect(() => mcpClientConfigSchema.parse({ servers: { x: { transport: "http" } } }))
    .toThrow();
});

it("accepts stdio + sse mix", () => {
  const parsed = mcpClientConfigSchema.parse(/* ... */);
  expect(Object.keys(parsed.servers)).toHaveLength(2);
});
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(mcp): client config schema and loader"
```

---

### Task 2: Wrappers de transport client-side

**Files:**
- Create: `src/mcp/transports/client-stdio.ts`
- Create: `src/mcp/transports/client-sse.ts`

- [ ] **Step 1: Stdio client transport**

```typescript
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpClientConfig } from "../client-config.schema";

type StdioServer = Extract<McpClientConfig["servers"][string], { transport: "stdio" }>;

export function buildStdioClientTransport(server: StdioServer): StdioClientTransport {
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...server.env } as Record<string, string>,
    cwd: server.cwd,
  });
}
```

- [ ] **Step 2: SSE client transport**

```typescript
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export function buildSseClientTransport(server: { url: string; headers: Record<string, string> }) {
  const url = new URL(server.url);
  return new SSEClientTransport(url, {
    requestInit: { headers: server.headers },
  });
}
```

- [ ] **Step 3: Commit**

---

### Task 3: ⚠ Ajustar regex de nome de skill para aceitar `mcp:<server>.<tool>`

**Files:**
- Modify: `src/skills/skill-manifest.schema.ts`
- Modify: `tests/unit/skills/skill-manifest.test.ts` (se existir)

- [ ] **Step 1: Decidir abordagem**

**Problema:** F8 definiu `name: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64)`. Os `:` e `.` no padrão `mcp:filesystem.read_file` violam essa regex.

**Opção A (recomendada):** relaxar a regex apenas para skills MCP. Adicionar regex permissiva e validar no adapter:

```typescript
const skillNameSchema = z.string().max(96).regex(
  /^([a-z][a-z0-9-]*|mcp:[a-z0-9-]+\.[a-z0-9_-]+)$/,
  "name: local [a-z0-9-] or mcp:<server>.<tool>",
);
```

**Opção B:** manter regex original, e no adapter substituir caracteres inválidos (`mcp_filesystem_read_file`). Menos legível.

Escolher **Opção A** — preserva legibilidade e debugging.

- [ ] **Step 2: Atualizar manifest schema sem quebrar built-in**

Testar com fixtures existentes que ainda passam.

- [ ] **Step 3: Atualizar testes**

```typescript
it("accepts mcp prefixed name", () => {
  const m = skillManifestSchema.parse({
    name: "mcp:filesystem.read_file",
    version: "1.0.0",
    description: "Read a file via MCP filesystem server",
    category: "knowledge",
    agentType: "surface",
    parameters: { type: "object" },
    entry: "index",
  });
  expect(m.name).toContain("mcp:");
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(skills): allow mcp: prefixed names in manifest schema"
```

---

### Task 4: MCP Tool → LoadedSkill adapter

**Files:**
- Create: `src/mcp/mcp-tool-adapter.ts`
- Create: `tests/unit/mcp/mcp-tool-adapter.test.ts`

- [ ] **Step 1: Implementar**

```typescript
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import pTimeout from "p-timeout";
import type { AgentExecutionContext } from "../agents/execution-context";
import type { LoadedSkill, SkillModule } from "../skills/skill-runtime";
import type { ToolResult } from "../tools/types";
import { logger } from "../infra/logger";

interface AdapterOpts {
  serverId: string;
  client: Client;
  timeoutMs: number;
  category?: "calendar" | "messaging" | "memory" | "knowledge";
}

/**
 * Adapta uma MCP Tool remota em um LoadedSkill registrável no SkillRegistry.
 * Permissões e roteamento continuam vindo do PermissionEvaluator existente.
 */
export function adaptMcpToolToSkill(tool: Tool, opts: AdapterOpts): LoadedSkill {
  const skillName = `mcp:${opts.serverId}.${tool.name}`;
  const category = opts.category ?? "knowledge"; // default categoria mais restritiva

  const module: SkillModule = {
    async execute(params: unknown, _ctx: AgentExecutionContext): Promise<ToolResult> {
      try {
        const result = await pTimeout(
          opts.client.callTool({
            name: tool.name,
            arguments: params as Record<string, unknown>,
          }),
          { milliseconds: opts.timeoutMs, message: `MCP timeout: ${skillName}` },
        );

        if (result.isError) {
          return {
            success: false,
            error: "MCP_TOOL_ERROR",
            detail: textOf(result.content),
          };
        }
        return { success: true, data: { content: result.content } };
      } catch (err) {
        logger.warn({ skill: skillName, err }, "mcp tool call failed");
        return {
          success: false,
          error: "MCP_CALL_FAILED",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  return {
    manifest: {
      name: skillName,
      version: "1.0.0",
      description: tool.description ?? `Remote MCP tool from ${opts.serverId}`,
      category,
      agentType: "surface",
      parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
      permissions: { requires: [], sideEffects: ["external_call"] },
      entry: "index",
    },
    module,
    manifestPath: `mcp://${opts.serverId}/${tool.name}`,
    skillDir: `mcp://${opts.serverId}`,
  };
}

function textOf(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return "no content";
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}
```

⚠ **Pitfall #1:** `tool.inputSchema` vem do servidor remoto — pode ser malformado. Validar com Ajv antes de aceitar (Task 5).

⚠ **Pitfall #2:** o `_ctx` é ignorado na chamada remota; servidor MCP não conhece `accountId`/`contactId` do Bevox. Por isso MCP tools são **categoricamente** read-only ou idempotentes na nossa default (`category: knowledge`). Operador que quiser elevar (ex: marcar como `memory` para um tool que grava) precisa **manualmente** override via mapping config (Task 6).

- [ ] **Step 2: Testes**

```typescript
it("adapts tool with name prefix", () => {
  const skill = adaptMcpToolToSkill(
    { name: "read_file", description: "Read", inputSchema: { type: "object" } },
    { serverId: "filesystem", client: fakeClient, timeoutMs: 5000 },
  );
  expect(skill.manifest.name).toBe("mcp:filesystem.read_file");
  expect(skill.manifest.category).toBe("knowledge");
});

it("returns MCP_TOOL_ERROR when remote returns isError", async () => {
  fakeClient.callTool = async () => ({ isError: true, content: [{ type: "text", text: "boom" }] });
  const skill = adaptMcpToolToSkill(/* ... */);
  const r = await skill.module.execute({}, fakeCtx);
  expect(r.success).toBe(false);
  expect(r.error).toBe("MCP_TOOL_ERROR");
});

it("times out long calls", async () => {
  fakeClient.callTool = () => new Promise(() => {}); // never resolves
  const skill = adaptMcpToolToSkill({}, { ..., timeoutMs: 50 });
  const r = await skill.module.execute({}, fakeCtx);
  expect(r.error).toBe("MCP_CALL_FAILED");
  expect(r.detail).toContain("timeout");
});
```

- [ ] **Step 3: Commit**

---

### Task 5: Validação de inputSchema remoto

**Files:**
- Modify: `src/mcp/mcp-tool-adapter.ts`

- [ ] **Step 1: Validar inputSchema com Ajv antes de aceitar**

```typescript
import Ajv from "ajv";
const ajv = new Ajv({ strict: false, allErrors: true });

export function validateRemoteInputSchema(schema: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof schema !== "object" || schema === null) {
    return { ok: false, reason: "inputSchema not an object" };
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== "object") return { ok: false, reason: "inputSchema.type must be 'object'" };
  try {
    ajv.compile(s);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `invalid json schema: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 2: No adapter, skipar tools com schema inválido**

```typescript
const validation = validateRemoteInputSchema(tool.inputSchema);
if (!validation.ok) {
  logger.warn(
    { server: opts.serverId, tool: tool.name, reason: validation.reason },
    "skipping MCP tool with invalid input schema",
  );
  return null; // adapter agora pode retornar null; ajustar tipo de retorno
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): validate remote inputSchema with ajv before adapting"
```

---

### Task 6: McpClientRegistry — lifecycle e descoberta

**Files:**
- Create: `src/mcp/client-registry.ts`
- Create: `src/mcp/client.ts`

- [ ] **Step 1: `client.ts` — wrapper de conexão**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildStdioClientTransport } from "./transports/client-stdio";
import { buildSseClientTransport } from "./transports/client-sse";
import type { McpClientConfig } from "./client-config.schema";

export interface ConnectedClient {
  serverId: string;
  client: Client;
  close: () => Promise<void>;
}

export async function connectMcpServer(
  serverId: string,
  server: McpClientConfig["servers"][string],
): Promise<ConnectedClient> {
  const transport = server.transport === "stdio"
    ? buildStdioClientTransport(server)
    : buildSseClientTransport(server);

  const client = new Client(
    { name: `bevox-harness-${serverId}`, version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return {
    serverId,
    client,
    close: async () => {
      try { await client.close(); } catch { /* swallow on shutdown */ }
    },
  };
}
```

- [ ] **Step 2: `client-registry.ts` — singleton**

```typescript
import type { ConnectedClient } from "./client";
import type { LoadedSkill } from "../skills/skill-runtime";

export class McpClientRegistry {
  private static instance: McpClientRegistry;
  private clients = new Map<string, ConnectedClient>();
  private skillsByServer = new Map<string, LoadedSkill[]>();

  static getInstance() {
    return (this.instance ??= new McpClientRegistry());
  }

  add(c: ConnectedClient, skills: LoadedSkill[]) {
    this.clients.set(c.serverId, c);
    this.skillsByServer.set(c.serverId, skills);
  }

  list(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  skillsFor(serverId: string): LoadedSkill[] {
    return this.skillsByServer.get(serverId) ?? [];
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.clients.values()).map((c) => c.close()));
    this.clients.clear();
    this.skillsByServer.clear();
  }
}
```

- [ ] **Step 3: Commit**

---

### Task 7: Bootstrap stage para carregar MCP clients

**Files:**
- Modify: `src/bootstrap/stages.ts`

- [ ] **Step 1: Implementar `loadMcpClientsStage`**

```typescript
import { loadMcpClientConfig } from "../config/mcp-servers";
import { connectMcpServer } from "../mcp/client";
import { McpClientRegistry } from "../mcp/client-registry";
import { adaptMcpToolToSkill } from "../mcp/mcp-tool-adapter";
import { SkillRegistry } from "../skills/skill-registry";

export async function loadMcpClientsStage(): Promise<void> {
  const config = await loadMcpClientConfig();
  if (!config) {
    logger.info("mcp client disabled or no config — skipping");
    return;
  }

  const reg = McpClientRegistry.getInstance();
  const skillReg = SkillRegistry.getInstance();
  const timeoutMs = config.defaults.timeoutMs;

  for (const [serverId, server] of Object.entries(config.servers)) {
    try {
      const connected = await connectMcpServer(serverId, server);
      const toolsResponse = await connected.client.listTools();
      const skills: LoadedSkill[] = [];

      for (const tool of toolsResponse.tools) {
        const skill = adaptMcpToolToSkill(tool, {
          serverId,
          client: connected.client,
          timeoutMs,
        });
        if (!skill) continue; // schema inválido, já logado
        try {
          skillReg.register(skill);
          skills.push(skill);
        } catch (err) {
          logger.warn({ serverId, tool: tool.name, err }, "skill register collision");
        }
      }

      reg.add(connected, skills);
      logger.info({ serverId, count: skills.length }, "mcp server connected, skills registered");
    } catch (err) {
      // ⚠ Graceful degradation: 1 servidor caído NÃO derruba o bootstrap inteiro
      logger.error({ serverId, err }, "mcp server connection failed — continuing without it");
    }
  }
}
```

⚠ **Decisão crítica:** **graceful degradation**. Se um servidor MCP externo está offline durante o bootstrap, o worker ainda sobe (sem aquele set de tools). Isso é diferente do bootstrap normal (qualquer falha → `process.exit(1)`). Alternativa estrita: env `MCP_REQUIRE_ALL=true` para forçar fail-fast. Documentar ambas.

- [ ] **Step 2: Inserir no pipeline de bootstrap (após stage 5, antes do consumer BullMQ)**

```typescript
// src/bootstrap/runner.ts (ou stages.ts dependendo do layout atual)
await loadSkillsStage();            // F8
await loadMcpClientsStage();        // ← NOVO (B.2)
await calendarHealthCheckStage();
await startConsumerStage();
```

- [ ] **Step 3: Shutdown hook — fechar todas connections em SIGTERM**

```typescript
// src/bootstrap/shutdown.ts
import { McpClientRegistry } from "../mcp/client-registry";
// dentro do handler:
await McpClientRegistry.getInstance().closeAll();
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mcp): bootstrap stage to connect external MCP servers"
```

---

### Task 8: Health check periódico + retry

**Files:**
- Create: `src/mcp/health.ts`

- [ ] **Step 1: Implementar ping periódico**

```typescript
import { McpClientRegistry } from "./client-registry";
import { logger } from "../infra/logger";

const PING_INTERVAL_MS = 60_000;

export function startMcpHealthLoop(): NodeJS.Timeout {
  return setInterval(async () => {
    for (const c of McpClientRegistry.getInstance().list()) {
      try {
        // SDK não tem ping nativo; usar listTools como heartbeat barato.
        // Cache do resultado fica no servidor; se cair, exception sobe.
        await c.client.listTools();
      } catch (err) {
        logger.warn({ serverId: c.serverId, err }, "mcp server unhealthy");
        // V1: apenas log. V2: marcar skills como temporariamente unavailable no evaluator.
      }
    }
  }, PING_INTERVAL_MS).unref();
}
```

⚠ V1 deliberadamente **não** remove skills caídas do registry — chamada falha retorna `MCP_CALL_FAILED` e reasoning loop decide o que fazer (já testado em Task 4). V2 pode introduzir circuit breaker; **deixar fora do escopo deste sprint**.

- [ ] **Step 2: Iniciar no bootstrap após `loadMcpClientsStage`**

- [ ] **Step 3: Commit**

---

### Task 9: Env vars

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Adicionar schema**

```typescript
MCP_CLIENT_ENABLED: z.coerce.boolean().default(false),
MCP_SERVERS_CONFIG_PATH: z.string().optional(),
MCP_CLIENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
MCP_REQUIRE_ALL: z.coerce.boolean().default(false),
```

- [ ] **Step 2: Refinement**

```typescript
.refine(
  (env) => !env.MCP_CLIENT_ENABLED || !!env.MCP_SERVERS_CONFIG_PATH,
  { message: "MCP_SERVERS_CONFIG_PATH required when MCP_CLIENT_ENABLED=true" },
)
```

- [ ] **Step 3: `.env.example`**

```bash
# === MCP Client (optional — consume external MCP servers as skills) ===
MCP_CLIENT_ENABLED=false
MCP_SERVERS_CONFIG_PATH=./mcp.config.json
MCP_CLIENT_TIMEOUT_MS=10000
MCP_REQUIRE_ALL=false   # true = fail bootstrap if any server unreachable
```

- [ ] **Step 4: Commit**

---

### Task 10: Testes de integração com servidor MCP fake

**Files:**
- Create: `tests/integration/mcp-client.test.ts`

- [ ] **Step 1: Subir servidor MCP fake in-process (usando server SDK do próprio @modelcontextprotocol/sdk)**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// (validar nome real do helper de transport in-memory na versão fixada do SDK)

it("connects to fake server and registers tool as skill", async () => {
  const server = new McpServer({ name: "fake", version: "0.0.1" });
  server.tool("echo", "Echo input", { type: "object", properties: { text: { type: "string" } } } as never,
    async ({ text }: { text: string }) => ({ content: [{ type: "text", text: `got:${text}` }] }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const skill = adaptMcpToolToSkill(tools.tools[0], {
    serverId: "fake",
    client,
    timeoutMs: 5000,
  });
  expect(skill?.manifest.name).toBe("mcp:fake.echo");

  const result = await skill!.module.execute({ text: "hello" }, /* ctx */ {} as never);
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Teste de timeout + graceful degradation**

```typescript
it("returns MCP_CALL_FAILED when server hangs", async () => {
  // server tool nunca responde
  // ... expect timeout error
});

it("continues bootstrap when one server unreachable", async () => {
  // 2 servers: 1 ok, 1 com command inválido (`/nonexistent`)
  // loadMcpClientsStage não throw; skills do server ok registradas
});
```

- [ ] **Step 3: Teste de permissão — MCP skill é filtrada pelo evaluator existente**

```typescript
it("respects denied list on MCP-prefixed skills", () => {
  // Setup execution context com denied: ["mcp:filesystem.read_file"]
  // evaluator retorna allowed: false
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "test(mcp): integration coverage for client lifecycle and registration"
```

---

### Task 11: Documentação + runbook + exemplo

**Files:**
- Create: `docs/architecture/mcp-client.md`
- Create: `docs/runbooks/mcp-add-external-server.md`
- Create: `examples/mcp.config.example.json` (já criado em Task 1; revisar)
- Modify: `README.md`

- [ ] **Step 1: `docs/architecture/mcp-client.md`** — design rationale, graceful degradation, security boundary, mapping `category` override

- [ ] **Step 2: `docs/runbooks/mcp-add-external-server.md`** — passos para conectar servidor

````markdown
# Adicionar servidor MCP externo

## 1. Criar `mcp.config.json`

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/var/data/bevox"]
    }
  }
}
```

## 2. Configurar env

```bash
MCP_CLIENT_ENABLED=true
MCP_SERVERS_CONFIG_PATH=/etc/bevox/mcp.config.json
```

## 3. Reiniciar worker

```bash
npm run start
# Logs esperados:
# {"msg":"mcp server connected, skills registered","serverId":"filesystem","count":5}
```

## 4. Verificar registro

```bash
curl localhost:9090/debug/skills | jq '.[].name' | grep "^mcp:"
```

(Se não houver endpoint debug, validar via log ou criar Task de seguimento.)

## 5. Habilitar para agentes

As MCP skills entram automaticamente no `SkillRegistry`. Para um surface agent **usar** uma skill MCP, adicionar o nome (`mcp:filesystem.read_file`) à lista `permissions.optional` ou `permissions.required` do `AgentDefinition` correspondente.

## 6. Negar uma skill MCP específica

Adicionar a `denied` no agent definition ou no `account_denied_tools` do execution context.
````

- [ ] **Step 3: README** — link para runbook

- [ ] **Step 4: Commit**

---

### Task 12: Validação final + PR

- [ ] **Step 1: Roteiro de smoke local**

```bash
# Servidor filesystem oficial como cobaia
cat > /tmp/mcp.test.json <<EOF
{
  "servers": {
    "fs": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
EOF

MCP_CLIENT_ENABLED=true MCP_SERVERS_CONFIG_PATH=/tmp/mcp.test.json npm run dev
```

Esperado nos logs:
- `mcp server connected, skills registered serverId=fs count=N`
- `skills loaded count=12+N` (12 built-in + N do filesystem)

- [ ] **Step 2: Chamar a skill via reasoning loop (manual via mensagem de teste)**

Disparar uma execução cujo intent leva o agent a chamar `mcp:fs.read_file`. Validar:
- Permission evaluator permite
- Tool call retorna content
- Reasoning loop não trava

- [ ] **Step 3: Abrir PR**

```bash
gh pr create --title "Sprint B.2: MCP Client (consume external servers)" \
  --body "$(cat docs/superpowers/plans/2026-05-14-sprint-b-2-mcp-client.md | head -40)"
```

- [ ] **Step 4: Aguardar CI verde + review**

---

## Definition of Done

- ✅ `MCP_CLIENT_ENABLED=false` (default) — bootstrap não muda comportamento atual
- ✅ Com config válido, bootstrap conecta a 1+ servidores e registra suas tools como `mcp:<server>.<tool>`
- ✅ Skill MCP é chamável via reasoning loop sem alteração nos engines
- ✅ Permission evaluator existente filtra MCP skills (testado com denied list)
- ✅ Graceful degradation: 1 servidor offline não derruba bootstrap (a menos que `MCP_REQUIRE_ALL=true`)
- ✅ Timeout por chamada (`MCP_CLIENT_TIMEOUT_MS`) retorna `MCP_CALL_FAILED` estruturado
- ✅ `inputSchema` malformado do servidor remoto é rejeitado com log warn (não derruba registro)
- ✅ Shutdown hook fecha todas connections em SIGTERM
- ✅ Conflito de nome (servidor remoto expõe tool que colide com built-in via prefixo) é resolvido pelo prefixo `mcp:`
- ✅ Health loop periódico detecta servidor caído e loga warn
- ✅ Runbook documenta passo-a-passo + override de category
- ✅ Testes integração cobrem: registro feliz, timeout, schema inválido, denied permission

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Colisão de nome com skills built-in (ex: servidor remoto expõe `read-profile`) | Prefixo `mcp:<server>.` garante unicidade — testar em Task 3 e 4 |
| Servidor MCP malicioso retorna content gigantesco e estoura context budget | Context builder já tem token budget (F8); MCP content entra como qualquer tool result; medir em load test futuro |
| Servidor MCP roda código arbitrário (transport stdio = spawn process) | `mcp.config.json` é trusted boundary; documentar como secret-equivalent (chmod 600); permissão por agent definition exige opt-in explícito |
| inputSchema do servidor remoto malformado quebra adapter | Task 5 valida com Ajv antes de registrar; tool com schema ruim é skipped com log |
| Conexão SSE keep-alive cai e tools ficam "zumbi" no registry | Health loop loga; V1 não remove; chamada subsequente retorna `MCP_CALL_FAILED` e reasoning decide |
| Servidor MCP responde lento e bloqueia reasoning loop | `pTimeout` por chamada (default 10s, configurável); engine recebe error e segue |
| Variáveis `${VAR}` em headers não interpoladas | Loader resolve antes de passar ao SDK; teste unitário valida |
| Conflito de versão `@modelcontextprotocol/sdk` com B.1 | Mergear na mesma janela; lockfile review obrigatório no PR |
| MCP tool com `category: knowledge` default em algo que escreve | Documentar override manual via mapping config (futuro); V1 prefere ser conservador |
| Worker reinicia mas servidor stdio externo fica zumbi | Stdio transport mata o subprocess via `transport.close()` no shutdown hook |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. **Status: BLOCKED até Sprint B.0 (ESM migration) — ver G.4 no [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14).**

### Bloqueante
- **G.4 — Sprint B.0 ESM migration obrigatório.** Mesmo problema de B.1: SDK ESM-only. B.0 cobre ambos.

### Critical (após B.0)
- **Task 2, ESM imports** — Após B.0, imports `@modelcontextprotocol/sdk/client/stdio.js` funcionam. Antes de B.0, todo `import` do SDK quebra.
- **Task 3, regex name** — `^([a-z][a-z0-9-]*|mcp:[a-z0-9-]+\.[A-Za-z0-9_-]+)$` para aceitar tools MCP com PascalCase/camelCase (servidores reais expõem `read_text_file`, `writeFile`). Atualizar `skill-manifest.schema.ts` testes correspondentes.
- **Task 4, context propagation** — Documentar limitação no DoD: contexto Bevox (`accountId`, `contactId`) NÃO atravessa fronteira MCP. Operador deve segregar via configuração do próprio servidor remoto (ex: filesystem root por account fora do harness).
- **Task 4, manifest validation** — Antes de registrar skill MCP sintética, rodar `skillManifestSchema.safeParse()` para garantir consistência. Hoje só `validateRemoteInputSchema` (Ajv) é enforçado.
- **Task 7, Step 2** — `loadMcpClientsStage` não cria função top-level. Adicionar entry ao array `buildStages` em `src/bootstrap/stages.ts`: `{ name: "load-mcp-clients", async execute() { await loadMcpClientsStage(); } }` após `load-tools-permissions`.
- **Task 9, MCP_CLIENT_ENABLED** — `z.coerce.boolean()` transforma `"false"` em `true`. Usar `z.enum(["true","false"]).transform(v => v === "true")`.
- **Task 10, server.tool no test** — Mesmo problema de B.1 Task 5: assinatura espera Zod shape, não JSON Schema cast. Usar `server.registerTool` ou Zod raw shape.

### Important
- **Task 1, env interpolação** — Implementar `substituteEnvVars(value: string): string` substituindo `${NAME}` por `process.env.NAME`, lança se var não definida. Sem isso, `Bearer ${TOKEN}` chega literal ao servidor remoto.
- **Task 4, p-timeout v6** — ESM-only, alinha com B.0. Pin `^6.1.0`.
- **Task 4, content shape** — Achatar `result.content` para `data: { text: textOf(result.content), raw: result.content }` para compat com `ToolResult.data` esperado pelo context builder.
- **Task 6, closeAll** — Cancelar `setInterval` do health loop no shutdown.
- **Task 8, health heartbeat** — Tentar `client.ping()` se SDK 1.x expor; caso contrário documentar custo de `listTools`.
- **Task 8, unavailableTools** — Documentar V1 limitation: chamada a tool de servidor offline falha com `MCP_CALL_FAILED` em invocação (não filtrada antes pelo evaluator). V2 marca `unavailableTools` dinamicamente.

### Nitpick
- Logger path: `src/config/logger.ts` (não `src/infra/logger.ts`) em todos snippets.
- Task 11 runbook — `curl localhost:9090/debug/skills` é pseudo (não existe endpoint). Marcar.
- Task 1+11 — `examples/mcp.config.example.json` listado em ambos, remover de Task 11.
- DoD — Adicionar: "`@modelcontextprotocol/sdk` na mesma versão `^1.29.0` que B.1; lockfile sem ambiguidade".
