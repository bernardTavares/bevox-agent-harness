# Phase 3: Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Endurecer postura de segurança com modelo de ameaça documentado, redação de PII em logs, validação reforçada de boundaries, auditoria de permissões persistida e rate limiting em tools mutantes — inspirado no SECURITY.md e arquitetura do Hermes.

**Architecture:** Validação Zod estrita em todos os boundaries (BullMQ payload, callbacks externos, Calendar responses). Pino redactors para PII. Tabela `permission_audit` persistindo tentativas negadas. Rate limiter Redis sliding window aplicado em tools com efeitos colaterais.

**Tech Stack:** Zod 4, Pino redactors, Redis sliding window (ioredis), nova migration SQL.

---

## Dependencies

- **Hard:** Nenhuma.
- **Soft:** Fase 2 (testes para validar regressões de segurança).
- **Blocks:** Nada diretamente.

## Files Touched

### Create
- `SECURITY.md`
- `src/security/redactors.ts`
- `src/security/rate-limiter.ts`
- `src/security/audit.ts`
- `src/integration/calendar-client.schemas.ts`
- `migrations/002_permission_audit.sql`
- `tests/unit/security/redactors.test.ts`
- `tests/unit/security/rate-limiter.test.ts`
- `tests/unit/security/audit.test.ts`

### Modify (⚠️ alto risco de conflito)
- ⚠️ `src/runtime/execution-handler.ts` — instrumentar audit, redactors
- ⚠️ `src/integration/llm-gateway.ts` — adicionar redactors (conflita com Fases 4, 5)
- ⚠️ `src/integration/calendar-client.ts` — validar resposta com Zod
- ⚠️ `src/integration/bevox-callback.ts` — validar X-Execution-Token consistente
- `src/memory/contact-profile.repository.ts` — auditoria SQL dinâmica
- `src/permissions/evaluator.ts` — chamar audit em deny
- `src/tools/messaging/send-message.tool.ts` — aplicar rate limiter
- `src/tools/messaging/request-human.tool.ts` — rate limiter
- `src/tools/calendar/create-appointment.tool.ts` — rate limiter
- `src/tools/calendar/cancel-appointment.tool.ts` — rate limiter
- `src/tools/calendar/reschedule-appointment.tool.ts` — rate limiter
- `src/runtime/execution-handler.ts` (e/ou `src/integration/bullmq-consumer.ts`) — schema do payload BullMQ mais estrito (`src/runtime/execution-context.ts` NÃO existe; `src/agents/execution-context.ts` é coisa diferente)
- `src/config/env.ts` — variáveis de rate limit
- `package.json`

### High-conflict files
- ⚠️ `src/runtime/execution-handler.ts` — também tocado por Fase 4
- ⚠️ `src/integration/llm-gateway.ts` — também tocado por Fases 4, 5
- ⚠️ `package.json`

## Estimated Effort
1 semana (~30-40 horas).

---

## Tasks

### Task 1: Documentar modelo de ameaça em `SECURITY.md`

**Files:**
- Create: `SECURITY.md`

- [ ] **Step 1: Criar `SECURITY.md` espelhando estrutura do Hermes**

```markdown
# Security Policy

## Trust Model

Bevox Agent Harness é um **serviço de domínio** dentro da plataforma Bevox. Não é um produto isolado; depende do orchestration-service para autenticar requisições.

### Fronteiras de confiança reais

1. **Boundary 1 — BullMQ payload:** confiamos que o orchestration-service enfileira jobs válidos. **Não confiamos no payload em si**: validamos com Zod estrito (tamanho, shape, valores).
2. **Boundary 2 — X-Execution-Token:** repassado ao Bevox via callback. Tratado como **opaque secret**, nunca logado, comparado por tempo constante quando validado.
3. **Boundary 3 — Calendar Service:** confiamos no transporte (rede interna), mas validamos toda resposta com Zod antes de usar.
4. **Boundary 4 — LLM providers:** respostas tratadas como **untrusted user input** para fins de parsing.

### O que é controle de segurança

- ✅ Validação Zod em boundaries
- ✅ Prepared statements em SQL
- ✅ Redação de PII em logs

### O que NÃO é controle de segurança (apenas "accident prevention")

- ⚠️ Sistema de permissões de tools — protege contra **mau uso de agentes**, não contra atacantes
- ⚠️ Rate limiting — proteção contra runaway loops, não DoS sofisticado
- ⚠️ Approval gates (se houver) — depende de operador humano

## Vulnerabilidades em escopo

- Bypass de validação em boundary
- SQL injection / NoSQL injection
- Vazamento de PII (`customer_name`, `customer_phone`, mensagens) em logs / traces / callbacks externos
- Vazamento de `X-Execution-Token` em logs / responses
- Vazamento de credenciais LLM
- Execução remota de código

## Fora de escopo

- Prompt injection no LLM (mitigação parcial via permissions, mas considerado risco assumido)
- Bypass de permissões via configuração interna
- DoS via flood de jobs BullMQ (responsabilidade do orchestration-service)

## Como reportar

Envie e-mail para **security@bevox.example** com:
- Descrição do problema
- Passos de reprodução
- Impacto estimado
- Sugestão de correção (opcional)

**NÃO** abra issue público para vulnerabilidades. Aguardamos até 90 dias para divulgação coordenada.
```

- [ ] **Step 2: Commit**

```bash
git add SECURITY.md
git commit -m "docs: add SECURITY.md with explicit threat model"
```

---

### Task 2: Pino redactors para PII

**Files:**
- Create: `src/security/redactors.ts`
- Create: `tests/unit/security/redactors.test.ts`
- Modify: arquivo central de criação do logger Pino (provavelmente `src/config/logger.ts` ou similar — confirmar localização)

- [ ] **Step 1: Criar lista de paths de redação em `src/security/redactors.ts`**

// Paths redacted em INFO+. Em DEBUG, redact é seletivo (ver REDACTION_DEBUG_PATHS).
// CRÍTICO: NÃO redact `messages.*.content` globalmente — quebra debugging dos engines.
// Redact só em saídas externas (callbacks, traces exportados).
export const PII_REDACTION_PATHS = [
  // Tokens (sempre redact)
  "execution_token",
  "executionToken",
  "*.execution_token",
  "*.token",
  "req.headers.x-execution-token",
  "res.headers.authorization",

  // PII — campos REAIS do ContactProfile (snake_case DB + camelCase TS)
  "*.full_name",
  "*.fullName",
  "*.preferred_name",
  "*.preferredName",
  "*.document_number",
  "*.documentNumber",
  "*.phone",
  "*.email",
  "*.address",
  "*.birth_date",
  "*.birthDate",
  // Aliases legacy/callback (manter por segurança caso outros sistemas usem)
  "*.customer_name",
  "*.customer_phone",
  "*.customer_email",

  // Credentials (sempre)
  "*.api_key",
  "*.apiKey",
  "*.password",
  "*.secret",
  "*.OPENAI_API_KEY",
  "*.ANTHROPIC_API_KEY",
  "*.GEMINI_API_KEY",

  // Callback payload (não dentro do harness — só na saída externa)
  "callback.payload.messages.*.content",
  "callback.payload.response",
];

// Paths sempre redacted, mesmo em DEBUG (tokens/keys)
export const REDACTION_ALWAYS_PATHS = [
  "execution_token",
  "*.execution_token",
  "*.token",
  "*.api_key",
  "*.apiKey",
  "*.password",
  "*.secret",
];

// Em DEBUG: só redact tokens/keys (mantém PII visível para troubleshooting local).
// Em INFO+: redact full PII list.
export function buildRedactionConfig(logLevel: string) {
  const isDebug = logLevel === "debug" || logLevel === "trace";
  return {
    paths: isDebug ? REDACTION_ALWAYS_PATHS : PII_REDACTION_PATHS,
    censor: "[REDACTED]",
    remove: false,
  };
}
```

- [ ] **Step 2: Aplicar no logger Pino**

```typescript
// src/config/logger.ts (ou equivalente)
import pino from "pino";
import { REDACTION_CONFIG } from "../security/redactors";

export const logger = pino({
  level: process.env.HARNESS_LOG_LEVEL ?? "info",
  redact: REDACTION_CONFIG,
  // ...
});
```

- [ ] **Step 3: Teste**

```typescript
// tests/unit/security/redactors.test.ts
import { describe, it, expect } from "vitest";
import pino from "pino";
import { REDACTION_CONFIG } from "../../../src/security/redactors";

describe("PII redactors", () => {
  it("redacts execution_token in logs", () => {
    const chunks: string[] = [];
    const logger = pino({ redact: REDACTION_CONFIG }, { write: (c: string) => chunks.push(c) });
    logger.info({ execution_token: "secret_abc" }, "test");
    expect(chunks.join("")).not.toContain("secret_abc");
    expect(chunks.join("")).toContain("[REDACTED]");
  });

  it("redacts nested customer_phone", () => {
    const chunks: string[] = [];
    const logger = pino({ redact: REDACTION_CONFIG }, { write: (c: string) => chunks.push(c) });
    logger.info({ context: { contact_profile: { phone: "+5511999998888" } } }, "test");
    expect(chunks.join("")).not.toContain("5511999998888");
  });
});
```

- [ ] **Step 4: Rodar teste, commit**

```bash
npm run test:unit -- redactors
git add src/security/redactors.ts src/config/logger.ts tests/
git commit -m "security: add Pino PII redactors"
```

---

### Task 3: Endurecer `executionPayloadSchema`

**Files:**
- Modify: `src/runtime/execution-context.ts` (ou onde o schema está definido)

- [ ] **Step 1: Localizar schema atual**

```bash
grep -rn "executionPayloadSchema" src/
```

- [ ] **Step 2: Adicionar bounds ao schema atual, SEM quebrar shape existente**

⚠ Schema real em `src/runtime/execution-handler.ts:38-55`:
- `account.id: z.number().int()` (NÃO uuid)
- `account_id: z.number().int().optional()` (alternativa flat)
- `agent_config: z.record(z.string(), z.unknown())` (lê `default_model` E `system_prompt` defensivamente)
- `conversation`, `context: z.record(z.string(), z.unknown())` (livre)

**Não usar `.strict()` no root** — quebra dispatches reais do Bevox. Adicionar apenas: limite de tamanho, bounds em token, regex em `default_model`.

```typescript
const MAX_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

export const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(MAX_MESSAGE_LENGTH),
  timestamp: z.string().datetime().optional(),
}).passthrough();

export const executionPayloadSchema = z.object({
  execution_id: z.string().uuid(),
  execution_token: z.string().min(20).max(512),
  // account.id é INTEGER (refs accounts(id) em migration 001)
  account: z.object({
    id: z.number().int(),
  }).passthrough(),
  account_id: z.number().int().optional(),  // alternativa flat aceita pelo handler real
  messages: z.array(messageSchema).max(MAX_MESSAGES).optional(),
  agent_config: z.record(z.string(), z.unknown())
    .refine((cfg) => {
      const model = cfg["default_model"];
      if (model === undefined) return true;
      return typeof model === "string" && /^[a-z0-9.\-_/]+$/i.test(model) && model.length <= 64;
    }, "default_model must match charset/length policy"),
  conversation: z.record(z.string(), z.unknown()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  skills: z.array(z.string()).max(50).optional(),
}).passthrough();

export function parsePayload(raw: unknown) {
  const json = JSON.stringify(raw);
  if (json.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return executionPayloadSchema.parse(raw);
}
```

- [ ] **Step 3: Teste**

```typescript
it("rejects payload > 256KB", () => {
  const huge = { execution_id: "...", messages: Array(1000).fill({ role: "user", content: "x".repeat(8000) }) };
  expect(() => parsePayload(huge)).toThrow(/exceeds/);
});

it("rejects invalid default_model charset", () => {
  const payload = { /* válido + */ agent_config: { default_model: "rm -rf /" } };
  expect(() => parsePayload(payload)).toThrow();
});

it("accepts real-world payload with system_prompt in agent_config", () => {
  const payload = { /* válido + */ agent_config: { default_model: "openai/gpt-4o-mini", system_prompt: "You are..." } };
  expect(() => parsePayload(payload)).not.toThrow();
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "security: tighten executionPayloadSchema with strict bounds"
```

---

### Task 4: Auditar uso do X-Execution-Token (saída apenas)

⚠ **Reescrita após audit do código real:** o harness **NÃO RECEBE** tokens via HTTP — não tem servidor HTTP exposto. Token é apenas **emitido** em callbacks outbound via header `X-Execution-Token` (ver `src/integration/bevox-callback.ts:15`). Não há site de comparação para `timingSafeEqual`.

**Files:** nenhum modificado (apenas audit).

- [ ] **Step 1: Confirmar que token é apenas outbound**

```bash
grep -rn "execution_token\|X-Execution-Token\|x-execution-token" src/
```
Esperado: ocorrências apenas em `bevox-callback.ts` (envio) e `execution-handler.ts` (recebido do payload + repassado). **Nenhum site de comparação.**

- [ ] **Step 2: Atualizar `SECURITY.md` Boundary 2**

Corrigir descrição: "Token é **outbound only**; harness não autentica callers (BullMQ job é considerado autoritativo). Validação reduzida a: (a) bounds Zod (Task 3), (b) redaction em logs (Task 2)."

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: clarify X-Execution-Token is outbound-only in SECURITY.md"
```

---

### Task 5: Schemas Zod para respostas Calendar Service

**Files:**
- Create: `src/integration/calendar-client.schemas.ts`
- Modify: `src/integration/calendar-client.ts`

- [ ] **Step 1: Capturar sample real de resposta antes de definir schemas**

⚠ `src/integration/calendar-client.ts` retorna `Promise<unknown>` em todas as chamadas. As ferramentas em `src/tools/calendar/*.tool.ts` fazem cast e leem campos específicos. Os nomes/shape exatos da resposta do Calendar Service **não estão neste repo** — campos podem ser snake_case.

**Passo zero obrigatório:** rodar uma chamada real (staging) e capturar a resposta com `console.log(JSON.stringify(raw, null, 2))`. OU ler `src/tools/calendar/*.tool.ts` para descobrir quais chaves cada tool consome — essa é a "shape efetiva" que os schemas precisam validar.

- [ ] **Step 1b: Schemas iniciais com `.passthrough()` (não-`.strict()`) — campos especulativos**

```typescript
// src/integration/calendar-client.schemas.ts
import { z } from "zod";

// ⚠ Field names sujeitos a confirmação contra resposta real.
// Começar permissivo; apertar em PR de seguimento após validar 1 sample real.
export const appointmentSchema = z.object({
  id: z.union([z.string(), z.number()]),
}).passthrough();

export const listAppointmentsResponseSchema = z.union([
  z.array(appointmentSchema),
  z.object({ appointments: z.array(appointmentSchema) }).passthrough(),
]);

export const healthResponseSchema = z.object({}).passthrough();
```

- [ ] **Step 2: Aplicar parsing após cada `fetch`**

```typescript
const raw = await response.json();
return listAppointmentsResponseSchema.parse(raw);
```

- [ ] **Step 3: Teste**

```typescript
it("rejects calendar response with extra fields", async () => {
  // mock fetch to return { appointments: [], total: 0, malicious: "field" }
  await expect(client.list("acc")).rejects.toThrow();
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "security: validate Calendar Service responses with Zod"
```

---

### Task 6: Auditoria SQL dinâmica em `ContactProfileRepository`

**Files:**
- Modify: `src/memory/contact-profile.repository.ts`

- [ ] **Step 1: Auditar `setClauses` construction (linhas ~64-68)**

```bash
grep -n "setClauses\|UPDATE contact_profiles" src/memory/contact-profile.repository.ts
```

- [ ] **Step 2: Reforçar `columnMap` existente — `update()` JÁ TEM whitelist**

⚠ Realidade: `contact-profile.repository.ts:41-58` já define `columnMap: Record<string, string>` mapeando 15 campos camelCase → snake_case (`fullName`→`full_name`, `documentNumber`→`document_number`, etc.). O risco real **não é SQL injection** (valores são parametrizados, colunas vêm de mapa fixo) — é **silent malformed SQL** quando uma chave desconhecida é passada (gera `undefined = $N`).

**Não inventar lista nova.** Usar `columnMap` como source of truth + lançar erro em chave desconhecida:

```typescript
const columnMap: Record<string, string> = { /* 15 campos existentes — não alterar */ };

async update(id: number, patch: Partial<ContactProfileFields>) {
  const entries = Object.entries(patch);
  for (const [key] of entries) {
    if (!(key in columnMap)) {
      throw new Error(`ContactProfile.update: unknown column "${key}"`);
    }
  }
  if (entries.length === 0) return null;

  const setClauses = entries.map(([k], i) => `${columnMap[k]} = $${i + 2}`);
  const sql = `UPDATE contact_profiles SET ${setClauses.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`;
  const params = [id, ...entries.map(([, v]) => v)];
  // ...
}
```

(Ler `src/memory/types.ts` para `ContactProfileFields` real.)

- [ ] **Step 3: Teste**

```typescript
it("rejects unknown column names", async () => {
  const repo = new ContactProfileRepository(mockClient);
  await expect(repo.update(1, { evilColumn: "x" } as any))
    .rejects.toThrow(/unknown column/);
});

it("uses parameterized values for malicious-looking strings", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const repo = new ContactProfileRepository({ query } as any);
  await repo.update(1, { fullName: "'; DROP TABLE--" });
  const [sql, params] = query.mock.calls[0];
  expect(sql).toContain("full_name");
  expect(sql).not.toContain("DROP");
  expect(params).toContain("'; DROP TABLE--");
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "security: whitelist columns in ContactProfile UPDATE"
```

---

### Task 7: Tabela `permission_audit` + auditoria de denies

**Files:**
- Create: `migrations/002_permission_audit.sql` (rate limiter usa Redis, não SQL)
- Create: `src/security/audit.ts`
- Create: `tests/unit/security/audit.test.ts`
- Modify: `src/permissions/evaluator.ts`

⚠ **Ordem obrigatória:** a migration deve ser aplicada **antes** do deploy de código novo. Caso contrário, todo `INSERT` falha e o `.catch()` fire-and-forget spammará warnings.

- [ ] **Step 0: Verificar signature atual de `evaluatePermission`**

```bash
grep -n "function evaluatePermission\|export.*evaluatePermission" src/permissions/
```
Se a função for síncrona, propagar `async` para todos os callers — isso é uma mudança ampla; auditar antes de prosseguir.

- [ ] **Step 1: Migration**

```sql
-- UP
CREATE TABLE permission_audit (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  account_id INTEGER NOT NULL,  -- bate com FK de accounts(id) em 001
  agent_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('agent_static', 'execution_context', 'allow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_permission_audit_execution ON permission_audit(execution_id);
CREATE INDEX idx_permission_audit_account_recent ON permission_audit(account_id, created_at DESC);
CREATE INDEX idx_permission_audit_deny ON permission_audit(decision, created_at DESC) WHERE decision = 'deny';

-- DOWN
DROP INDEX IF EXISTS idx_permission_audit_deny;
DROP INDEX IF EXISTS idx_permission_audit_account_recent;
DROP INDEX IF EXISTS idx_permission_audit_execution;
DROP TABLE IF EXISTS permission_audit;
```

- [ ] **Step 2: `src/security/audit.ts`**

```typescript
import type { Pool } from "pg";

export interface PermissionAuditEntry {
  executionId: string;
  accountId: string;
  agentName: string;
  toolName: string;
  decision: "allow" | "deny";
  reason?: string;
  layer: "agent_static" | "execution_context" | "allow";
}

export class PermissionAuditLogger {
  constructor(private pool: Pool) {}

  async log(entry: PermissionAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO permission_audit
       (execution_id, account_id, agent_name, tool_name, decision, reason, layer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entry.executionId, entry.accountId, entry.agentName, entry.toolName,
       entry.decision, entry.reason ?? null, entry.layer],
    );
  }
}
```

- [ ] **Step 3: Integrar em `evaluator.ts` — MANTER FUNÇÃO SÍNCRONA**

⚠ Realidade: `evaluatePermission(tool, agent, context)` é **síncrona** com 3 args posicionais. `filterPermittedTools` também é síncrona e chamada síncrona em `execution-handler.ts`. **Não converter para async** — quebra cascata de callers.

Estratégia: audit logger é fire-and-forget dentro da função síncrona; `PermissionContext` é estendida com `executionId` (não existe hoje — adicionar em `src/permissions/types.ts`).

```typescript
// src/permissions/types.ts — adicionar executionId
export interface PermissionContext {
  executionId: string;  // ← novo campo
  agentName: string;
  agentType: 'pipeline' | 'surface';
  accountId: number;
  inboxId?: number;
  conversationKey: string;
  unavailableTools: string[];
  accountDeniedTools: string[];
}

// src/permissions/evaluator.ts — manter sync, adicionar audit opcional
let auditLogger: PermissionAuditLogger | null = null;
export function setPermissionAuditLogger(logger: PermissionAuditLogger) {
  auditLogger = logger;
}

export function evaluatePermission(
  tool: ToolDefinition,
  agent: AgentDefinition,
  context: PermissionContext,
): PermissionResult {
  const result = /* lógica existente — não alterar */;

  // Fire-and-forget audit (não bloqueia, não muda assinatura)
  if (auditLogger) {
    auditLogger.log({
      executionId: context.executionId,
      accountId: context.accountId,
      agentName: agent.name,
      toolName: tool.name,
      decision: result.granted ? "allow" : "deny",
      reason: result.granted ? undefined : result.reason,
      layer: result.granted ? "allow" : layerFromReason(result.reason),
    }).catch((err) => logger.warn({ err }, "permission_audit_failed"));
  }

  return result;
}

function layerFromReason(r: PermissionDenialReason): 'agent_static' | 'execution_context' | 'allow' {
  if (r === 'AGENT_STATIC_DENIED' || r === 'AGENT_TYPE_MISMATCH') return 'agent_static';
  return 'execution_context';
}
```

- [ ] **Step 3b: Construir `auditLogger` no bootstrap e injetar via `setPermissionAuditLogger()`**

- [ ] **Step 3c: Adicionar `executionId` ao `PermissionContext` em todos os callsites**

```bash
grep -rn "PermissionContext\b" src/
```
Cada construção precisa passar `executionId`. Em `execution-handler.ts:370` (filterPermittedTools call), construir context com `executionId: execution_id`.

- [ ] **Step 4: Teste**

- [ ] **Step 5: Commit**

```bash
git commit -m "security: persist permission decisions to audit table"
```

---

### Task 8: Rate limiter (sliding window Redis)

**Files:**
- Create: `src/security/rate-limiter.ts`
- Create: `tests/unit/security/rate-limiter.test.ts`
- Modify: `src/config/env.ts`

- [ ] **Step 1: `src/security/rate-limiter.ts`**

```typescript
import type Redis from "ioredis";

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  constructor(private redis: Redis) {}

  async check(opts: RateLimitOptions): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    const redisKey = `rate:${opts.key}`;

    // Pipeline: [0] zremrangebyscore, [1] zcard (count ANTES de adicionar — N permitido, N+1 bloqueado),
    // [2] zadd (sempre adiciona o evento, mesmo se bloqueado, para evitar burst após reset),
    // [3] pexpire.
    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zcard(redisKey);
    pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);
    pipeline.pexpire(redisKey, opts.windowMs);
    const results = await pipeline.exec();
    if (!results) throw new Error("rate-limiter: pipeline discarded");

    const zcardResult = results[1] as [Error | null, number];
    if (zcardResult[0]) throw zcardResult[0];
    const count = zcardResult[1];

    const allowed = count < opts.limit;
    return {
      allowed,
      remaining: Math.max(0, opts.limit - count - 1),
      resetIn: opts.windowMs,
    };
  }
}
```

- [ ] **Step 2: Adicionar config em `src/config/env.ts`**

```typescript
RATE_LIMIT_SEND_MESSAGE_PER_MINUTE: z.coerce.number().int().positive().default(20),
RATE_LIMIT_CALENDAR_MUTATIONS_PER_MINUTE: z.coerce.number().int().positive().default(10),
RATE_LIMIT_REQUEST_HUMAN_PER_HOUR: z.coerce.number().int().positive().default(5),
```

- [ ] **Step 3: Aplicar em tools mutantes (helper compartilhado)**

```typescript
// helper em src/tools/_shared/rate-limit.ts
export async function enforceRateLimit(
  limiter: RateLimiter,
  accountId: string,
  toolName: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const result = await limiter.check({
    key: `${accountId}:${toolName}`,
    limit,
    windowMs,
  });
  if (!result.allowed) {
    throw new RateLimitError(`Rate limit exceeded for ${toolName}`, result.resetIn);
  }
}
```

Aplicar em (arquivos reais com sufixo `.tool.ts`): `send-message.tool.ts`, `request-human.tool.ts`, `create-appointment.tool.ts`, `cancel-appointment.tool.ts`, `reschedule-appointment.tool.ts`.

- [ ] **Step 4: Testes**

```typescript
it("allows N requests then blocks", async () => {
  const redis = createFakeRedis();
  const limiter = new RateLimiter(redis);
  for (let i = 0; i < 5; i++) {
    const r = await limiter.check({ key: "k", limit: 5, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
  }
  const r = await limiter.check({ key: "k", limit: 5, windowMs: 60_000 });
  expect(r.allowed).toBe(false);
});
```

- [ ] **Step 5: Commit por etapa**

```bash
git commit -m "security: add Redis sliding window rate limiter"
git commit -m "security: enforce rate limits on mutating tools"
```

---

### Task 9: PR final + validação

- [ ] **Step 1: Rodar migration**

```bash
psql $DATABASE_URL -f migrations/002_permission_audit.sql
```

- [ ] **Step 1b: Smoke test E2E de auditoria**

Provocar um deny deliberado (ex: tool denylisted no agent) e verificar `SELECT * FROM permission_audit WHERE decision='deny' ORDER BY created_at DESC LIMIT 1` retorna a entrada.

- [ ] **Step 1c: Documentar rate-limit defaults em `.env.example` e README**

- [ ] **Step 2: Rodar testes completos**

```bash
npm test
npm run test:integration
```

- [ ] **Step 3: PR**

```bash
gh pr create --title "Phase 3: Security Hardening" --body "Threat model, redactors, validation, audit, rate limiting"
```

---

## Definition of Done

- ✅ `SECURITY.md` publicado
- ✅ Logger Pino redact PII em 100% dos paths sensíveis
- ✅ `executionPayloadSchema` rejeita payload > 256KB e fields desconhecidos
- ✅ Comparações de token via `timingSafeEqual`
- ✅ Respostas Calendar validadas com Zod
- ✅ SQL UPDATE em `contact_profiles` usa whitelist
- ✅ Tabela `permission_audit` populada para cada deny
- ✅ Rate limiter ativo em 5 tools mutantes
- ✅ Cobertura nova ≥ 80% nos arquivos `src/security/*`

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Redactors mascarando demais (perde debugging) | Whitelist explícita de paths; logs em DEBUG mantêm correlação por executionId não-redacted |
| Audit table cresce sem controle | Política de retenção (job de cleanup) em backlog; particionar por mês se >1M rows |
| Rate limit falso-positivo em produção | Começar com limites generosos; monitorar deny rate antes de apertar |
| Conflito com Fase 4 em `execution-handler.ts` | Coordenar merge order; ver INDEX para sequência |
