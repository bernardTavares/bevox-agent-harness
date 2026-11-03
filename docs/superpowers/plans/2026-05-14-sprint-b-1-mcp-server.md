# Sprint B.1: MCP Server (expor skills via Model Context Protocol)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expor as 12 built-in skills do harness (`src/skills-builtin/**`) como um **MCP server** compatível com a especificação Model Context Protocol, em duas modalidades de transporte (`stdio` e `SSE`). Permite que clientes MCP padrão (Claude Desktop, Cursor, Cline, Zed) consumam as capabilities do Bevox como tools nativas — sem alterar reasoning engines, LLM Gateway ou o permission evaluator atual.

**Architecture:** Um processo MCP server adicional, separado do worker BullMQ, lê do `SkillRegistry` já populado pelo bootstrap (F8) e adapta cada `LoadedSkill` em uma `MCP Tool` (`{ name, description, inputSchema }`). O server suporta dois transports: `stdio` para integração local (Claude Desktop spawna o processo) e `SSE` para acesso remoto autenticado por bearer token. Permissão é filtrada **antes** da exposição via env `MCP_EXPOSED_SKILLS` (whitelist glob), e novamente em runtime via `PermissionEvaluator` existente sobre um `AgentExecutionContext` sintético "mcp-external".

**Tech Stack:** `@modelcontextprotocol/sdk` (oficial Anthropic, TypeScript), `zod-to-json-schema` para converter `parameters` (JSON Schema já é o formato do manifest, mas precisamos garantir `$schema` draft compatível com MCP), `micromatch` para glob da whitelist, `node:http` para SSE transport. CLI binary via `bin/bevox-mcp.ts` registrado em `package.json`.

**⚠ Constraint de processo:** o MCP server **NÃO** é o mesmo processo do worker BullMQ — ele apenas reaproveita o `SkillLoader` + `SkillRegistry` em modo standalone. Isso evita acoplar lifecycle de fila com lifecycle de cliente MCP (Claude Desktop pode reiniciar o processo a qualquer momento via SIGTERM).

---

## Dependencies

- **Hard:** Fase 8 (`src/skills/` + `src/skills-builtin/` já mergeados — substrato obrigatório).
- **Soft:** Fase 1 (CI roda lint/typecheck nos novos arquivos), Fase 3 (permissions evaluator estável).
- **Blocks:** Nada. Independente do Sprint B.2 (MCP client), mas compartilha a dependência `@modelcontextprotocol/sdk` — coordenar versão única no `package.json`.
- **⚠ Não substituir** o LLM Gateway, o reasoning loop ou o permission evaluator. O MCP server é uma **camada de exposição** sobre o `SkillRegistry`.

## Files Touched

### Create
- `src/mcp/server.ts` — fábrica do `McpServer` (SDK), wiring de transports
- `src/mcp/transports/stdio.ts` — adapter para `StdioServerTransport`
- `src/mcp/transports/sse.ts` — adapter SSE com auth bearer + CORS opcional
- `src/mcp/adapters/skill-to-mcp.ts` — converte `LoadedSkill` em `MCP Tool` (incluindo invocação)
- `src/mcp/adapters/permission-filter.ts` — glob whitelist + integração com `PermissionEvaluator`
- `src/mcp/execution-context.ts` — factory para `AgentExecutionContext` sintético "mcp-external"
- `bin/bevox-mcp.ts` — CLI entrypoint (parse args, escolhe transport, inicia server)
- `tests/unit/mcp/skill-to-mcp.test.ts`
- `tests/unit/mcp/permission-filter.test.ts`
- `tests/integration/mcp-server.stdio.test.ts` (spawna server, conversa via stdio com cliente sintético do SDK)
- `tests/integration/mcp-server.sse.test.ts`
- `docs/architecture/mcp-server.md`
- `docs/runbooks/mcp-server-claude-desktop.md` (passo-a-passo para conectar Claude Desktop)

### Modify
- `package.json` — adicionar `"bin": { "bevox-mcp": "./dist/bin/bevox-mcp.js" }`, dependência `@modelcontextprotocol/sdk`, `zod-to-json-schema`, `micromatch`, script `mcp:dev`
- `src/config/env.ts` — novas env vars (`MCP_TRANSPORT`, `MCP_EXPOSED_SKILLS`, `MCP_SERVER_TOKEN`, `MCP_SSE_PORT`, `MCP_SSE_HOST`)
- `src/bootstrap/stages.ts` — **NÃO** modificar (MCP server é processo separado). Reaproveita `SkillLoader` mas roda seu próprio bootstrap mínimo (stages 2 + 3 + 5 do harness)
- `README.md` — seção "MCP Server" com exemplo de `claude_desktop_config.json`
- `tsconfig.json` — confirmar que `bin/**/*.ts` está em `include` ou criar `tsconfig.bin.json` complementar
- `.gitignore` — `bin/*.js` se `bin/` for compilado para si mesmo

### High-conflict files
- ⚠️ `package.json` — conflita com Sprint B.2 (mesma dependência `@modelcontextprotocol/sdk`); coordenar ordem de merge
- ⚠️ `src/config/env.ts` — adicionar todas as `MCP_*` vars de uma vez para evitar conflito

## Estimated Effort
1.5 semanas (~40-50 horas).

---

## Tasks

### Task 1: Instalar SDK MCP e dependências auxiliares

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Instalar pacotes**

```bash
npm install @modelcontextprotocol/sdk zod-to-json-schema micromatch
npm install --save-dev @types/micromatch
```

- [ ] **Step 2: Confirmar versão do SDK** — fixar minor para evitar drift de spec

```json
"@modelcontextprotocol/sdk": "^1.0.0"
```

⚠ O SDK oficial mudou de `@anthropic-ai/mcp-sdk` para `@modelcontextprotocol/sdk` em 2024. Validar que `node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js` existe (export CJS) — projeto é CommonJS.

- [ ] **Step 3: Smoke test de import**

```bash
node -e "console.log(Object.keys(require('@modelcontextprotocol/sdk/server/mcp.js')))"
```
Expected: lista contendo `McpServer`.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(mcp): install @modelcontextprotocol/sdk and helpers"
```

---

### Task 2: Adapter SkillManifest → MCP Tool

**Files:**
- Create: `src/mcp/adapters/skill-to-mcp.ts`
- Create: `tests/unit/mcp/skill-to-mcp.test.ts`

- [ ] **Step 1: Implementar adapter (não invoca, apenas descreve)**

```typescript
import type { LoadedSkill } from "../../skills/skill-runtime";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Converte um LoadedSkill em descritor MCP Tool.
 *
 * `manifest.parameters` já é JSON Schema (validado por Zod em F8),
 * então mapeamos 1:1. Apenas garantimos o `$schema` correto.
 */
export function skillToMcpTool(skill: LoadedSkill): McpToolDescriptor {
  return {
    name: skill.manifest.name,
    description: skill.manifest.description,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      ...skill.manifest.parameters,
    },
  };
}
```

- [ ] **Step 2: Implementar invocação — wrap em ToolResult → MCP CallToolResult**

```typescript
import type { ToolResult } from "../../tools/types";

export function toolResultToMcpContent(result: ToolResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (!result.success) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: result.error,
            errorCode: result.errorCode,
            detail: result.detail,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.data ?? {}, null, 2) }],
  };
}
```

⚠ MCP retorna **sempre** content array. Não vazar stack traces — `detail` no shape acima é texto controlado pelo próprio skill.

- [ ] **Step 3: Testes**

```typescript
it("converts skill to mcp tool descriptor", () => {
  const fakeSkill: LoadedSkill = {
    manifest: {
      name: "send-message",
      version: "1.0.0",
      description: "Send a response message to the customer.",
      category: "messaging",
      agentType: "surface",
      parameters: { type: "object", required: ["message"], properties: { message: { type: "string" } } },
      permissions: { requires: [], sideEffects: ["external_call", "stop_signal"] },
      entry: "index",
    },
    module: { execute: async () => ({ success: true }) },
    manifestPath: "",
    skillDir: "",
  };
  const tool = skillToMcpTool(fakeSkill);
  expect(tool.name).toBe("send-message");
  expect(tool.inputSchema.required).toEqual(["message"]);
});

it("maps failed ToolResult to isError MCP content", () => {
  const r = toolResultToMcpContent({ success: false, error: "VALIDATION", detail: "bad" });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("VALIDATION");
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mcp): adapter from SkillManifest to MCP Tool descriptor"
```

---

### Task 3: Permission filter para exposição

**Files:**
- Create: `src/mcp/adapters/permission-filter.ts`
- Create: `tests/unit/mcp/permission-filter.test.ts`

- [ ] **Step 1: Implementar filtro de exposição (whitelist glob)**

```typescript
import micromatch from "micromatch";
import type { LoadedSkill } from "../../skills/skill-runtime";

/**
 * Filtra quais skills são EXPOSTAS via MCP. Avaliado UMA vez na startup.
 *
 * @param skills    todas skills carregadas no SkillRegistry
 * @param patterns  array de padrões glob (ex: ["calendar.*", "memory.read-profile"])
 *                  vindo de env MCP_EXPOSED_SKILLS (csv)
 *
 * Convenção de matching: o "id" do skill é `${category}.${name}` (NÃO o `name` cru).
 * Isso permite expor categorias inteiras com `calendar.*` sem listar 6 skills.
 */
export function filterExposedSkills(skills: LoadedSkill[], patterns: string[]): LoadedSkill[] {
  if (patterns.length === 0) return []; // fail-closed: sem patterns → expõe nada
  return skills.filter((s) => {
    const id = `${s.manifest.category}.${s.manifest.name}`;
    return micromatch.isMatch(id, patterns);
  });
}
```

⚠ **Fail-closed por design.** Se `MCP_EXPOSED_SKILLS` for vazio, o server inicia mas não expõe nada — operador precisa explicitar o que liberar. Documentar em `mcp-server.md`.

- [ ] **Step 2: Filtro de runtime — usar PermissionEvaluator existente**

```typescript
import { evaluatePermission } from "../../permissions/evaluator";
import type { AgentExecutionContext } from "../../agents/execution-context";

export function isAllowedAtRuntime(
  skill: LoadedSkill,
  context: AgentExecutionContext,
): { allowed: true } | { allowed: false; reason: string } {
  const result = evaluatePermission({
    toolName: skill.manifest.name,
    agentType: skill.manifest.agentType,
    context,
  });
  if (!result.allowed) {
    return { allowed: false, reason: result.reason ?? "denied by permission evaluator" };
  }
  return { allowed: true };
}
```

- [ ] **Step 3: Testes**

```typescript
it("returns empty when no patterns provided (fail-closed)", () => {
  expect(filterExposedSkills([s1, s2], [])).toHaveLength(0);
});

it("matches category glob", () => {
  const out = filterExposedSkills([cal1, cal2, mem1], ["calendar.*"]);
  expect(out).toHaveLength(2);
});

it("matches exact dotted id", () => {
  const out = filterExposedSkills([cal1, mem1], ["memory.read-profile"]);
  expect(out.map((s) => s.manifest.name)).toEqual(["read-profile"]);
});
```

- [ ] **Step 4: Commit**

---

### Task 4: AgentExecutionContext sintético para MCP

**Files:**
- Create: `src/mcp/execution-context.ts`

- [ ] **Step 1: Implementar factory**

```typescript
import { randomUUID } from "node:crypto";
import type { AgentExecutionContext } from "../agents/execution-context";

/**
 * Constrói um AgentExecutionContext mínimo quando uma chamada MCP externa
 * invoca uma skill. NÃO há executionToken Bevox (calls vindas de MCP não voltam
 * para callbacks Bevox), mas mantemos a shape para reaproveitar PermissionEvaluator.
 */
export function buildMcpExecutionContext(opts: {
  accountId: string;
  contactId?: string;
}): AgentExecutionContext {
  return {
    executionId: `mcp-${randomUUID()}`,
    accountId: opts.accountId,
    contactId: opts.contactId ?? "mcp-external",
    agentName: "mcp-external",
    // Skills que dependem de executionToken vão falhar com erro estruturado —
    // intencional: send-message/request-human NÃO devem ser expostas via MCP.
    // Documentar isso e default de MCP_EXPOSED_SKILLS ser calendar.*, memory.read-*, knowledge.*
  } as AgentExecutionContext;
}
```

⚠ **Decisão de design crítica:** skills com `sideEffects: [stop_signal]` (send-message, request-human) **NÃO devem ser expostas via MCP** por default. Elas pressupõem um loop de raciocínio Bevox + `executionToken` para callback. Documentar no manifest schema que cliente MCP que tentar invocá-las recebe `CALLBACK_ERROR`.

- [ ] **Step 2: Commit**

---

### Task 5: McpServer factory + tools registration

**Files:**
- Create: `src/mcp/server.ts`

- [ ] **Step 1: Implementar factory**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkillRegistry } from "../skills/skill-registry";
import { filterExposedSkills, isAllowedAtRuntime } from "./adapters/permission-filter";
import { skillToMcpTool, toolResultToMcpContent } from "./adapters/skill-to-mcp";
import { buildMcpExecutionContext } from "./execution-context";
import { getEnv } from "../config/env";
import { logger } from "../infra/logger";

export interface BuildMcpServerOptions {
  /** Override do accountId padrão (default: env BEVOX_DEFAULT_ACCOUNT_ID ou "mcp-default") */
  accountId?: string;
}

export function buildMcpServer(opts: BuildMcpServerOptions = {}): McpServer {
  const env = getEnv();
  const patterns = (env.MCP_EXPOSED_SKILLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const all = SkillRegistry.getInstance().list();
  const exposed = filterExposedSkills(all, patterns);

  logger.info(
    { total: all.length, exposed: exposed.length, patterns },
    "mcp server exposing skills",
  );

  const server = new McpServer({
    name: "bevox-agent-harness",
    version: process.env.npm_package_version ?? "0.0.0",
  });

  const accountId = opts.accountId ?? env.BEVOX_DEFAULT_ACCOUNT_ID ?? "mcp-default";

  for (const skill of exposed) {
    const descriptor = skillToMcpTool(skill);
    server.tool(
      descriptor.name,
      descriptor.description,
      descriptor.inputSchema as never, // SDK aceita JSON Schema; cast porque tipo nominal é Zod
      async (params: unknown) => {
        const ctx = buildMcpExecutionContext({ accountId });
        const gate = isAllowedAtRuntime(skill, ctx);
        if (!gate.allowed) {
          return toolResultToMcpContent({
            success: false,
            error: "PERMISSION_DENIED",
            detail: gate.reason,
          });
        }
        try {
          const result = await skill.module.execute(params, ctx);
          return toolResultToMcpContent(result);
        } catch (err) {
          return toolResultToMcpContent({
            success: false,
            error: "SKILL_EXCEPTION",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  }

  return server;
}
```

- [ ] **Step 2: Smoke test inline**

```bash
npm run build && node -e "
  process.env.MCP_EXPOSED_SKILLS = 'calendar.*';
  require('./dist/bootstrap/stages').loadSkillsStage().then(() => {
    const s = require('./dist/mcp/server').buildMcpServer();
    console.log('server built ok');
  });
"
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): McpServer factory wiring skills as MCP tools"
```

---

### Task 6: Stdio transport

**Files:**
- Create: `src/mcp/transports/stdio.ts`

- [ ] **Step 1: Implementar**

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../../infra/logger";

export async function runStdioTransport(server: McpServer): Promise<void> {
  // ⚠ Stdio transport NÃO pode logar para stdout — stdout é o canal MCP.
  // O Pino default escreve em stdout; redirecionar para stderr neste modo.
  process.stdout.write = process.stderr.write.bind(process.stderr) as never;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp stdio transport connected");

  // Manter processo vivo até SIGTERM/SIGINT (Claude Desktop encerra assim)
  const shutdown = async () => {
    logger.info("mcp stdio shutting down");
    await transport.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
```

⚠ **Pitfall #1:** Pino escreve em stdout por padrão. No modo stdio, isso **corrompe o canal MCP** (cliente recebe JSON-RPC misturado com logs). A reatribuição acima é defensiva; alternativa mais limpa é configurar logger separado em `src/mcp/logger.ts` com destination stderr. Escolher uma das duas — não as duas.

- [ ] **Step 2: Teste manual com MCP Inspector**

```bash
npx @modelcontextprotocol/inspector node dist/bin/bevox-mcp.js --transport stdio
```
Expected: UI web abre, lista tools de `calendar.*`, conseguimos chamar uma e ver resposta.

- [ ] **Step 3: Commit**

---

### Task 7: SSE transport com auth bearer

**Files:**
- Create: `src/mcp/transports/sse.ts`

- [ ] **Step 1: Implementar**

```typescript
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getEnv } from "../../config/env";
import { logger } from "../../infra/logger";

interface SseTransportOptions {
  host: string;
  port: number;
  authToken: string;
}

function checkAuth(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  // Comparação constant-time
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function runSseTransport(server: McpServer, opts: SseTransportOptions): Promise<void> {
  const transports = new Map<string, SSEServerTransport>();

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!checkAuth(req, opts.authToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "GET" && req.url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await server.connect(transport);
    } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
      const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId");
      const t = sessionId ? transports.get(sessionId) : undefined;
      if (!t) {
        res.writeHead(404).end();
        return;
      }
      await t.handlePostMessage(req, res);
    } else {
      res.writeHead(404).end();
    }
  });

  http.listen(opts.port, opts.host, () => {
    logger.info({ host: opts.host, port: opts.port }, "mcp sse transport listening");
  });
}
```

⚠ **Pitfall:** SSE precisa de `Connection: keep-alive`. Atrás de proxy (nginx, ALB) configurar `proxy_buffering off` e timeout idle alto. Documentar no runbook.

- [ ] **Step 2: Teste com curl**

```bash
TOKEN=$(openssl rand -hex 32) MCP_SERVER_TOKEN=$TOKEN node dist/bin/bevox-mcp.js --transport sse &
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:7071/sse
```
Expected: stream SSE abre, `endpoint` event chega.

- [ ] **Step 3: Teste de auth negativa**

```bash
curl -N http://localhost:7071/sse
```
Expected: 401.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mcp): SSE transport with bearer auth and session multiplex"
```

---

### Task 8: CLI binary `bin/bevox-mcp.ts`

**Files:**
- Create: `bin/bevox-mcp.ts`
- Modify: `package.json` (`bin` field, `files` field)
- Modify: `tsconfig.json` (incluir `bin/**/*` em `include`)

- [ ] **Step 1: Implementar entrypoint**

```typescript
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadSkillsStage } from "../src/bootstrap/stages";
import { buildMcpServer } from "../src/mcp/server";
import { runStdioTransport } from "../src/mcp/transports/stdio";
import { runSseTransport } from "../src/mcp/transports/sse";
import { getEnv } from "../src/config/env";
import { logger } from "../src/infra/logger";

async function main() {
  const { values } = parseArgs({
    options: {
      transport: { type: "string", default: "stdio" },
    },
  });

  const transport = values.transport ?? "stdio";
  const env = getEnv();

  // Bootstrap mínimo: apenas carregar skills (não BullMQ, não DB pool extra)
  await loadSkillsStage();

  const server = buildMcpServer();

  if (transport === "stdio") {
    await runStdioTransport(server);
  } else if (transport === "sse") {
    if (!env.MCP_SERVER_TOKEN) {
      logger.error("MCP_SERVER_TOKEN required for sse transport");
      process.exit(1);
    }
    await runSseTransport(server, {
      host: env.MCP_SSE_HOST ?? "127.0.0.1",
      port: env.MCP_SSE_PORT ?? 7071,
      authToken: env.MCP_SERVER_TOKEN,
    });
  } else {
    logger.error({ transport }, "unknown transport (use stdio or sse)");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, "mcp bin failed");
  process.exit(1);
});
```

- [ ] **Step 2: `package.json`**

```json
{
  "bin": {
    "bevox-mcp": "./dist/bin/bevox-mcp.js"
  },
  "files": ["dist/", "bin/"],
  "scripts": {
    "mcp:dev": "tsx bin/bevox-mcp.ts --transport stdio",
    "mcp:sse": "tsx bin/bevox-mcp.ts --transport sse"
  }
}
```

- [ ] **Step 3: `tsconfig.json`**

```json
{
  "include": ["src/**/*", "bin/**/*"]
}
```

⚠ Se `bin/` ficar fora de `rootDir: "src"`, ajustar `rootDir` para `"."` OU mover `bin/bevox-mcp.ts` para `src/bin/bevox-mcp.ts` e apontar `package.json#bin` para `./dist/bin/bevox-mcp.js`. Recomendo **mover para `src/bin/`** para manter `rootDir: "src"` (default do projeto).

- [ ] **Step 4: Smoke test build**

```bash
npm run build
ls dist/bin/bevox-mcp.js
chmod +x dist/bin/bevox-mcp.js
./dist/bin/bevox-mcp.js --transport stdio < /dev/null  # roda e bloqueia esperando JSON-RPC
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(mcp): CLI binary bevox-mcp with stdio/sse transports"
```

---

### Task 9: Env vars novas

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Adicionar schema**

```typescript
MCP_TRANSPORT: z.enum(["stdio", "sse"]).optional(),
MCP_EXPOSED_SKILLS: z.string().optional(), // csv glob: "calendar.*,memory.read-profile"
MCP_SERVER_TOKEN: z.string().min(32).optional(), // obrigatório se transport=sse
MCP_SSE_HOST: z.string().default("127.0.0.1"),
MCP_SSE_PORT: z.coerce.number().int().min(1).max(65535).default(7071),
BEVOX_DEFAULT_ACCOUNT_ID: z.string().optional(),
```

- [ ] **Step 2: Validação cross-field**

```typescript
.refine(
  (env) => env.MCP_TRANSPORT !== "sse" || (env.MCP_SERVER_TOKEN?.length ?? 0) >= 32,
  { message: "MCP_SERVER_TOKEN (min 32 chars) required when MCP_TRANSPORT=sse" },
)
```

- [ ] **Step 3: Atualizar `.env.example`**

```bash
# === MCP Server (optional — only needed for `bevox-mcp` binary) ===
MCP_TRANSPORT=stdio                            # stdio | sse
MCP_EXPOSED_SKILLS=calendar.*,memory.read-profile,knowledge.*
MCP_SERVER_TOKEN=                              # bearer for sse, generate with: openssl rand -hex 32
MCP_SSE_HOST=127.0.0.1
MCP_SSE_PORT=7071
BEVOX_DEFAULT_ACCOUNT_ID=mcp-default
```

- [ ] **Step 4: Commit**

---

### Task 10: Testes de integração end-to-end

**Files:**
- Create: `tests/integration/mcp-server.stdio.test.ts`
- Create: `tests/integration/mcp-server.sse.test.ts`

- [ ] **Step 1: Stdio test — usa client do próprio SDK contra processo spawned**

```typescript
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

it("lists exposed skills via stdio", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/bin/bevox-mcp.js", "--transport", "stdio"],
    env: { ...process.env, MCP_EXPOSED_SKILLS: "knowledge.*" },
  });
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name)).toContain("search-faq");
  await client.close();
});
```

- [ ] **Step 2: SSE test — sobe transport em porta dinâmica**

```typescript
it("rejects unauthenticated SSE connections", async () => {
  const res = await fetch("http://127.0.0.1:7071/sse");
  expect(res.status).toBe(401);
});

it("accepts authenticated SSE and lists tools", async () => {
  // ... usar SSEClientTransport do SDK com header Authorization
});
```

- [ ] **Step 3: Teste de permissão runtime — skill bloqueada retorna isError**

```typescript
it("returns isError when skill denied by evaluator", async () => {
  // Force denied list no env
  // Chamar tool e assertar response.isError === true
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "test(mcp): integration coverage for stdio and sse transports"
```

---

### Task 11: Documentação + runbook

**Files:**
- Create: `docs/architecture/mcp-server.md`
- Create: `docs/runbooks/mcp-server-claude-desktop.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/architecture/mcp-server.md`** — design, fail-closed, transports, security model

- [ ] **Step 2: `docs/runbooks/mcp-server-claude-desktop.md`**

````markdown
# Conectar Claude Desktop ao Bevox Agent Harness

## 1. Build do binary

```bash
npm install -g .
# ou local:
npm run build && npm link
which bevox-mcp
```

## 2. Configurar Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bevox": {
      "command": "bevox-mcp",
      "args": ["--transport", "stdio"],
      "env": {
        "DATABASE_URL": "postgres://localhost:5432/bevox_dev",
        "REDIS_URL": "redis://localhost:6379",
        "MCP_EXPOSED_SKILLS": "calendar.*,memory.read-profile,knowledge.*",
        "BEVOX_DEFAULT_ACCOUNT_ID": "dev-account-001"
      }
    }
  }
}
```

## 3. Verificar

Reabrir Claude Desktop → ícone de tools mostra `search-faq`, `read-calendar`, etc.
````

- [ ] **Step 3: README** — seção "Expor harness via MCP" com link para o runbook

- [ ] **Step 4: Commit + PR**

```bash
git commit -m "docs(mcp): architecture doc + Claude Desktop runbook"
```

---

### Task 12: Validação final com MCP Inspector + PR

- [ ] **Step 1: Roteiro de smoke completo**

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/bin/bevox-mcp.js --transport stdio
```

Checklist na UI do inspector:
- [ ] `tools/list` retorna apenas skills do glob configurado
- [ ] `tools/call` em `search-faq` retorna `content` válido
- [ ] `tools/call` em skill não exposta retorna erro `method not found`
- [ ] Skill com permissão denied retorna `isError: true` com `PERMISSION_DENIED`

- [ ] **Step 2: Abrir PR**

```bash
gh pr create --title "Sprint B.1: MCP Server (expose skills)" \
  --body "$(cat docs/superpowers/plans/2026-05-14-sprint-b-1-mcp-server.md | head -40)"
```

- [ ] **Step 3: Aguardar CI verde + review**

---

## Definition of Done

- ✅ `npm run build` produz `dist/bin/bevox-mcp.js` executável
- ✅ `bevox-mcp --transport stdio` conecta com Claude Desktop e expõe skills do glob
- ✅ `bevox-mcp --transport sse` aceita conexões autenticadas e rejeita não-autenticadas
- ✅ MCP Inspector lista as tools com schemas corretos (parâmetros + descrições)
- ✅ Skill bloqueada pelo PermissionEvaluator retorna `isError: true` (não vaza stack)
- ✅ Pino logs vão para stderr no modo stdio (canal MCP em stdout intacto)
- ✅ `MCP_EXPOSED_SKILLS=""` resulta em zero tools expostas (fail-closed)
- ✅ Testes de integração stdio e sse passam em CI
- ✅ Runbook documenta passo-a-passo Claude Desktop e config SSE com bearer
- ✅ Coordenação com B.2 — `@modelcontextprotocol/sdk` em versão única no `package.json`

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Pino corrompe canal stdio escrevendo em stdout | Reatribuir `process.stdout.write` ou criar logger dedicado em stderr; testado no Task 6 |
| Schema do skill incompatível com MCP draft | Manifest já usa JSON Schema draft-07; adapter força `$schema`; se SDK exigir draft-2020-12, ajustar no adapter sem mexer manifest |
| Tunneling SSE atrás de proxy quebra keep-alive | Runbook documenta `proxy_buffering off` + timeouts; alternativa é Streamable HTTP transport (futuro) |
| Skills com `stop_signal` expostas e quebram sem `executionToken` | Default `MCP_EXPOSED_SKILLS` documentado **exclui** `messaging.*`; runtime retorna `CALLBACK_ERROR` estruturado |
| Múltiplos clientes SSE compartilham mesmo McpServer e race em tool exec | Tools são stateless (cada call cria `AgentExecutionContext` novo); validar com teste concorrente |
| `npm link` em dev confunde resolução de skills built-in | CLI faz bootstrap mínimo lendo de `__dirname` resolvido — testar em ambiente limpo |
| Conflito de versão `@modelcontextprotocol/sdk` com Sprint B.2 | Mergear B.1 primeiro; B.2 herda versão fixada; revisar lockfile no PR seguinte |
| Token MCP_SERVER_TOKEN vazado em logs | Logger nunca loga env; bearer comparado constant-time; documentar rotação |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. **Status: BLOCKED até Sprint B.0 (ESM migration) — ver G.4 no [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14).**

### Bloqueante
- **G.4 — Sprint B.0 ESM migration obrigatório antes deste plano.** `@modelcontextprotocol/sdk@1.29` é ESM-only, projeto é CJS. Sem B.0 (migração para `module: NodeNext`), nenhum import do SDK compila/roda. Plano B.0 a ser criado: 1-2 dias para migrar tsconfig, ajustar imports `.js`, validar build/CI.

### Critical (a aplicar após B.0)
- **Task 1, SDK version** — Pin `@modelcontextprotocol/sdk` em `^1.29.0` (não `^1.0.0`). Versões 1.x divergem em API.
- **Task 1, smoke CJS** — Substituir `require()` por `await import()` dinâmico OU postponer smoke até B.0 ter migrado tsconfig.
- **Task 2, descriptor name** — Convenção única: `descriptor.name = "${category}.${name}"` (ex: `calendar.read-calendar`) em TODOS os pontos (filter, register, testes). Sem isso há colisão entre `memory.read-profile` e `calendar.read-profile` futuros.
- **Task 3, evaluatePermission** — Assinatura real: `evaluatePermission(tool: ToolDefinition, agent: AgentDefinition, context: PermissionContext)`, não `{ toolName, agentType, context }`. `PermissionResult` usa `granted: true|false` + `reason: PermissionDenialReason` (enum), não `allowed`/string. Reescrever Task 3 Step 2 inteiro construindo `AgentDefinition` sintético "mcp-external" + `ToolDefinition` sintético + `PermissionContext`.
- **Task 4, context** — `buildMcpExecutionContext` deveria construir `PermissionContext`, não `AgentExecutionContext`. `accountId` é `number` (usar `z.coerce.number()` no env). Skills built-in que usam `ctx.db`/`ctx.llmClient` vão crashar via MCP — expandir whitelist default para excluir TODAS skills que tocam DB/LLM, não só `messaging.*`.
- **Task 5, server.tool API** — SDK 1.x: `server.registerTool(name, { description, inputSchema }, handler)` aceita JSON Schema cru, OU `server.tool()` exige Zod raw shape. Decidir e converter via `json-schema-to-zod` se necessário. Snippet atual não compila.
- **Task 6, stdout monkey-patch** — REMOVER `process.stdout.write` override. Criar logger Pino dedicado em `src/mcp/logger.ts` apontando para `pino.destination(2)` (stderr fd). Stdio transport usa stdout — qualquer interferência corrompe JSON-RPC.
- **Task 8, rootDir** — Binary em `src/bin/bevox-mcp.ts` (dentro de `rootDir: src`). `package.json#bin` → `./dist/bin/bevox-mcp.js`. Descartar Opção A (mudar rootDir).
- **Task 9, env type** — `BEVOX_DEFAULT_ACCOUNT_ID: z.coerce.number().int().optional()` (number, não string).

### Important
- **Goal** — Premissa "evaluator reusado tal-qual" é incompleta. Adicionar Task: definir `MCP_EXTERNAL_AGENT_DEFINITION` com `permissions.denied` configurável via env `MCP_DENIED_SKILLS=send-message,request-human,write-fact,write-profile`.
- **Task 4** — Enforcement de stop_signal: rejeitar automaticamente skills com `sideEffects: ["stop_signal"]` no `filterExposedSkills` (não só comentário). `send-message` e `request-human` dependem de `executionToken` Bevox — não exponíveis.
- **Task 7, SSE deprecated** — Documentar migração para `StreamableHTTPServerTransport` em runbook. Se manter SSE, pin SDK version e marcar como dívida técnica.
- **Task 7, race** — Inverter: `await server.connect(transport)` antes de `transports.set(transport.sessionId, transport)`.
- **DoD** — Adicionar smoke E2E: "Claude Desktop real (não Inspector) invoca `knowledge.search-faq` e recebe content".
- **Riscos** — Adicionar: "skills built-in dependem de `ctx.db` e `ctx.llmClient`, maioria não-exponível via MCP server out-of-the-box".

### Nitpick
- Logger path correto: `src/config/logger.ts` (não `src/infra/logger.ts`).
- Versão MCP Inspector pinada no runbook.
- `bin/*.js` em `.gitignore` desnecessário (dist/ já coberto).
