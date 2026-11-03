# Phase 7: Dev Environment Reproducibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Permitir que qualquer dev faça `git clone && docker compose up && npm run dev` e tenha o ambiente completo funcionando, inspirado na abordagem `flake.nix` + Dockerfile do Hermes (sem o overhead do Nix).

**Architecture:** `docker-compose.yml` com 3 serviços (postgres, redis, harness). `Dockerfile.dev` com hot reload via tsx + volume mount. `.envrc` opcional para direnv. Scripts em `package.json` para subir/derrubar infra.

**Tech Stack:** Docker Compose v2, Dockerfile multi-stage, direnv (opcional), .env.example, postgres:16-alpine, redis:7-alpine.

---

## Dependencies

- **Hard:** Nenhuma.
- **Soft:** Nenhuma.
- **Blocks:** Nada. Pode rodar em paralelo com qualquer fase.

## Files Touched

### Create
- `docker-compose.yml`
- `Dockerfile`
- `Dockerfile.dev`
- `.dockerignore`
- `.envrc`
- `.env.example`
- `scripts/dev-up.mjs` (Node script — cross-platform, sem bash)
- `scripts/dev-down.mjs`
- `scripts/migrate.mjs` (idempotente, com tabela `schema_migrations`)
- `scripts/enqueue-test-job.mjs` (smoke test via BullMQ API real)

### Modify
- `package.json` (scripts `docker:up`, `docker:down`, `docker:logs`)
- `README.md` (seção Quickstart)
- `.gitignore` (se necessário: `.env`, volumes)

### High-conflict files
- ⚠️ `package.json` — Fases 1, 2, 4, 5, 6
- ⚠️ `README.md` — Fase 1

## Estimated Effort
2-3 dias (~12-16 horas).

---

## Tasks

### Task 1: `.env.example` completo

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Listar todas as vars conhecidas (cross-referenciar com `src/config/env.ts`)**

```bash
# Database
DATABASE_URL=postgres://harness:harness@localhost:5432/bevox_harness

# Redis
REDIS_URL=redis://localhost:6379

# Bevox callbacks
BEVOX_CALLBACK_BASE_URL=http://localhost:3000

# Calendar service
CALENDAR_SERVICE_URL=http://localhost:3009/api

# LLM
OPENAI_API_KEY=sk-...
# OPENAI_API_KEYS=sk-...,sk-...
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=
DEFAULT_LLM_PROVIDER=openai
DEFAULT_LLM_MODEL=gpt-4o-mini

# Harness
HARNESS_QUEUE_NAME=execution.dispatch.agent_harness
HARNESS_MAX_EXECUTION_TIME_MS=120000
HARNESS_LOG_LEVEL=info

# Observability (Fase 4)
OTEL_ENABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
OTEL_SERVICE_NAME=bevox-agent-harness
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore: add .env.example with all known variables"
```

---

### Task 2: `docker-compose.yml`

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Compor 3 serviços**

⚠ Decisões:
- **Sem mount em `docker-entrypoint-initdb.d`** — migrations rodam via `scripts/migrate.mjs` idempotente (Task 4). Evita duplicação na 1ª subida.
- **`env_file` opcional** via `env_file: { path: .env, required: false }` (Compose v2.24+) — não quebra se `.env` ausente.
- **`CHOKIDAR_USEPOLLING=true`** para hot reload funcionar em Windows/WSL2 bind mounts.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: harness
      POSTGRES_PASSWORD: harness
      POSTGRES_DB: bevox_harness
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harness -d bevox_harness"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  harness:
    build:
      context: .
      dockerfile: Dockerfile.dev
    environment:
      DATABASE_URL: postgres://harness:harness@postgres:5432/bevox_harness
      REDIS_URL: redis://redis:6379
      HARNESS_LOG_LEVEL: debug
      CHOKIDAR_USEPOLLING: "true"
      TSX_WATCH_POLL: "true"
    env_file:
      - path: .env
        required: false
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./src:/app/src
      - ./package.json:/app/package.json:ro
      - ./tsconfig.json:/app/tsconfig.json:ro
    ports:
      - "9229:9229"
    command: npm run dev

volumes:
  postgres-data:
  redis-data:
```

- [ ] **Step 2: Validar**

```bash
docker compose config
docker compose up -d postgres redis
docker compose ps
```

- [ ] **Step 3: Commit**

```bash
git commit -m "build: add docker-compose for local dev infra"
```

---

### Task 3: Dockerfiles

**Files:**
- Create: `Dockerfile`, `Dockerfile.dev`, `.dockerignore`

- [ ] **Step 1: `.dockerignore`**

```
node_modules
dist
coverage
.git
.env
.env.*
!.env.example
*.log
.husky/_
.github
docs
tests
.changeset
```

Importante: padrão `.env.*` evita vazar `.env.local`, `.env.production`, etc., mas mantém `.env.example`.

- [ ] **Step 2: `Dockerfile.dev`** (hot reload)

```dockerfile
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++ \
  && ln -sf python3 /usr/bin/python

COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 9229

CMD ["npm", "run", "dev"]
```

- [ ] **Step 3: `Dockerfile`** (produção, multi-stage)

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S harness && adduser -S harness -G harness
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER harness
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Validar build**

```bash
docker build -t bevox-harness:dev -f Dockerfile.dev .
docker build -t bevox-harness:latest -f Dockerfile .
```

- [ ] **Step 5: Commit**

```bash
git commit -m "build: add Dockerfile (prod) and Dockerfile.dev (hot reload)"
```

---

### Task 4: Scripts de conveniência

**Files:**
- Create: `scripts/dev-up.sh`, `scripts/dev-down.sh`, `scripts/migrate.sh`

⚠ Scripts em Node (`.mjs`) em vez de bash — cross-platform sem Git Bash/WSL.

- [ ] **Step 1: `scripts/dev-up.mjs`**

```javascript
#!/usr/bin/env node
import { existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

if (!existsSync(".env")) {
  console.log("→ Creating .env from .env.example");
  copyFileSync(".env.example", ".env");
  console.log("⚠ Edit .env with real values before continuing");
}

console.log("→ Starting infra...");
execSync("docker compose up -d postgres redis", { stdio: "inherit" });

console.log("→ Waiting for postgres...");
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    execSync("docker compose exec -T postgres pg_isready -U harness -d bevox_harness", { stdio: "ignore" });
    break;
  } catch {
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log("→ Running migrations...");
execSync("node scripts/migrate.mjs", { stdio: "inherit" });

console.log("✓ Infra ready. Run 'npm run dev' to start harness.");
```

- [ ] **Step 2: `scripts/dev-down.mjs`**

```javascript
#!/usr/bin/env node
import { execSync } from "node:child_process";
execSync("docker compose down", { stdio: "inherit" });
console.log("✓ Infra stopped (volumes preserved)");
```

- [ ] **Step 3: `scripts/migrate.mjs` — idempotente com tabela `schema_migrations`**

```javascript
#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import "dotenv/config";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

const files = readdirSync("migrations").filter(f => f.endsWith(".sql")).sort();
for (const f of files) {
  const { rows } = await client.query("SELECT 1 FROM schema_migrations WHERE filename=$1", [f]);
  if (rows.length > 0) {
    console.log(`✓ ${f} already applied`);
    continue;
  }
  const sql = readFileSync(join("migrations", f), "utf8");
  const upMatch = sql.match(/-- UP[\s\S]*?(?=-- DOWN|$)/);
  await client.query("BEGIN");
  try {
    await client.query(upMatch ? upMatch[0] : sql);
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [f]);
    await client.query("COMMIT");
    console.log(`→ Applied ${f}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
await client.end();
```

- [ ] **Step 3b: `scripts/enqueue-test-job.mjs` — smoke test via BullMQ API real**

```javascript
#!/usr/bin/env node
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import "dotenv/config";

const queue = new Queue(process.env.HARNESS_QUEUE_NAME ?? "execution.dispatch.agent_harness", {
  connection: { url: process.env.REDIS_URL },
});

await queue.add("execution.dispatch", {
  execution_id: randomUUID(),
  execution_token: "test-token-" + randomUUID(),
  account: { id: "00000000-0000-0000-0000-000000000001" },
  messages: [{ role: "user", content: "quero marcar uma consulta" }],
  agent_config: {},
});

console.log("✓ Test job enqueued");
await queue.close();
```

- [ ] **Step 4: Tornar executáveis (Unix) e adicionar scripts npm**

```json
"docker:up": "node scripts/dev-up.mjs",
"docker:down": "node scripts/dev-down.mjs",
"docker:logs": "docker compose logs -f harness",
"db:migrate": "node scripts/migrate.mjs",
"smoke:enqueue": "node scripts/enqueue-test-job.mjs"
```

Funciona nativamente em Windows, macOS e Linux — sem dependência de Git Bash/WSL.

- [ ] **Step 5: Commit**

```bash
git commit -m "build: add dev convenience scripts"
```

---

### Task 5: `.envrc` para direnv (opcional)

**Files:**
- Create: `.envrc`

- [ ] **Step 1: `.envrc`**

```bash
# Auto-load .env when entering directory (requires direnv: https://direnv.net)
dotenv

# Node version
use node 20

# Helpful PATH additions
PATH_add ./node_modules/.bin
```

- [ ] **Step 2: Documentar no README como opcional**

- [ ] **Step 3: Commit**

```bash
git commit -m "build: add .envrc for direnv users (optional)"
```

---

### Task 6: Atualizar README com Quickstart

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Seção no topo do README, depois da descrição**

```markdown
## Quickstart

Requisitos: Docker Desktop (ou compatível), Node 20+, npm.

```bash
# 1. Clone
git clone https://github.com/bernardTavares/bevox-agent-harness.git
cd bevox-agent-harness

# 2. Install
nvm use            # opcional, usa .nvmrc
npm ci

# 3. Subir infra (postgres + redis + migrations)
npm run docker:up

# 4. Configurar .env (se ainda não fez)
$EDITOR .env       # adicionar OPENAI_API_KEY etc.

# 5. Rodar harness
npm run dev
```

### Comandos úteis

| Comando | Descrição |
|---|---|
| `npm run docker:up` | Sobe postgres + redis + roda migrations |
| `npm run docker:down` | Para infra (volumes preservados) |
| `npm run docker:logs` | Tail logs do harness em container |
| `npm run db:migrate` | Aplica migrations pendentes |
| `npm run dev` | Harness com hot reload local |
| `npm test` | Roda testes |

### Tudo em Docker (alternativa)

```bash
docker compose up
```

Inclui o serviço `harness` rodando dentro do container com volume mount em `src/`.
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add Quickstart section to README"
```

---

### Task 7: Validação end-to-end

- [ ] **Step 1: Em máquina limpa (ou após `rm -rf node_modules && docker compose down -v`)**

```bash
git clone <repo>
cd bevox-agent-harness
npm ci
npm run docker:up
cp .env.example .env  # editar com keys reais
npm run dev
```

Expected: harness inicia em < 30s, bootstrap 7 estágios verde, consumer ouvindo.

- [ ] **Step 2: Smoke test via BullMQ API real**

```bash
npm run smoke:enqueue
```

Verificar nos logs do harness que o job foi consumido. NÃO usar `redis-cli RPUSH` direto — BullMQ tem estrutura de chaves própria (`bull:<queue>:wait`) que não pode ser populada por RPUSH ingênuo.

- [ ] **Step 3: Commit final + PR**

---

## Definition of Done

- ✅ `docker compose up` sobe postgres + redis + harness
- ✅ Migrations aplicadas automaticamente na primeira subida
- ✅ Hot reload funcional via volume mount
- ✅ `Dockerfile` de produção builda < 2 min
- ✅ Imagem prod < 200MB
- ✅ Quickstart no README testado em ambiente limpo
- ✅ Scripts `dev-up.sh`/`dev-down.sh`/`migrate.sh` funcionais

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Permissões de scripts no Windows | Documentar uso via Git Bash/WSL; alternativamente reescrever em Node |
| Volumes Docker bloqueiam hot reload no Windows | Recomendar WSL2; alternativa: usar `polling` no tsx watch |
| Versão de postgres divergente em prod | Pinar `postgres:16-alpine` (mesma da prod, idealmente) |
| `docker-entrypoint-initdb.d` roda só na primeira subida | Documentar; usar `npm run db:migrate` para incrementais |
