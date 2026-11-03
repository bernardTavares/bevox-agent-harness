# Phase 8: Pluggable Skills Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Introduzir mecanismo de **skills plugáveis** (manifest-driven) inspirado em `skills/<categoria>/` do Hermes, mantendo compatibilidade com as 13 tools existentes. Permite carregar skills externos sem alterar código-fonte do harness.

**Architecture:** Cada skill é um diretório `src/skills-builtin/<category>/<name>/` (dentro de `rootDir: "src"` para `tsc` compilar) com `manifest.yaml` + `index.ts` exportando `{ execute(params, ctx): Promise<ToolResult> }`. Carregador no bootstrap descobre, valida com Zod, e registra dinamicamente. **Tools atuais permanecem em `src/tools/` durante a transição** — `SkillRegistry` e `ToolRegistry` coexistem por um PR cycle até migração completa. Skills externas via `SKILLS_PATH` (apenas `.js` pre-compiladas, opt-in explícito em produção).

**Tech Stack:** `js-yaml`, dynamic import via `require()` (CommonJS — bate com `tsconfig.json` atual), Zod para manifest schema, Ajv para validar `parameters` como JSON Schema.

**⚠ Constraint de build:** projeto é CommonJS (`tsconfig.json` `module: "CommonJS"`, sem `"type": "module"` no `package.json`). Skills built-in devem ficar **dentro de `src/`** para `tsc` compilá-las junto. Loader em prod resolve para `dist/skills-builtin/`; em dev (`tsx`) resolve para `src/skills-builtin/`.

---

## Dependencies

- **Hard:** Idealmente Fase 2 (estrutura de testes pronta para validar regressões).
- **Soft:** Fase 3 (permissions já robustas), Fase 1 (CI roda testes de regressão).
- **Blocks:** Nada.
- **⚠ Esta é a fase mais ARQUITETURALMENTE INVASIVA — recomendado executar isolada, depois das outras.**

## Files Touched

### Create
- `src/skills/skill-manifest.schema.ts`
- `src/skills/skill-loader.ts`
- `src/skills/skill-registry.ts`
- `src/skills/skill-runtime.ts`
- `src/skills-builtin/README.md`
- `src/skills-builtin/messaging/send-message/manifest.yaml`
- `src/skills-builtin/messaging/send-message/index.ts`
- `src/skills-builtin/messaging/request-human/manifest.yaml` + `index.ts`
- `src/skills-builtin/calendar/<6 skills>/manifest.yaml` + `index.ts`
- `src/skills-builtin/memory/<3 skills>/manifest.yaml` + `index.ts`
- `src/skills-builtin/knowledge/search-faq/manifest.yaml` + `index.ts`
- `tests/unit/skills/skill-loader.test.ts`
- `tests/unit/skills/skill-runtime.test.ts`
- `tests/unit/skills/skill-security.test.ts` (path traversal, prod gate)
- `tests/integration/skills.integration.test.ts`
- `docs/architecture/skills.md`

### Modify (⚠️ profundo)
- ⚠️ `src/tools/registry.ts` — passa a delegar para `SkillRegistry` mas mantém interface
- ⚠️ `src/bootstrap/stages.ts` (estágio que registra tools — atenção ao array hardcoded `KNOWN_TOOL_NAMES` linhas ~36-49: ou remover ou reescrever para consumir `SkillRegistry.list()`) — adicionar carregamento de skills antes de registrar tools legadas
- `src/tools/types.ts` — **não modificar `ToolResult`** (atual: `{ success, data?, error?, errorCode?, detail? }`). Skills retornam exatamente esse shape.
- `src/tools/*` (13 arquivos) — **permanecem no lugar durante coexistência**; em PR final são removidos quando todas as skills equivalentes estão validadas
- `src/config/env.ts` — `SKILLS_PATH`, `ALLOW_EXTERNAL_SKILLS`
- `src/permissions/evaluator.ts` — **decisão necessária:** o manifest declara `permissions.requires` e `sideEffects`, mas evaluator atual usa `denied`/`agentType`/context. Em V1: **manter modelo atual**; `requires`/`sideEffects` ficam apenas como metadata documental (não enforced) até V2. Declarar explicitamente isso no manifest schema.
- `README.md`
- `package.json`

### High-conflict files
- ⚠️ Praticamente tudo em `src/tools/` é tocado
- ⚠️ Estágio de bootstrap

## Estimated Effort
3-4 semanas (~80-100 horas) — fase mais longa por ser refatoração ampla.

---

## Tasks

### Task 1: Schema de Manifest

**Files:**
- Create: `src/skills/skill-manifest.schema.ts`

- [ ] **Step 1: Definir schema Zod com validação estrita de parameters**

```typescript
import { z } from "zod";

// `parameters` deve ser um JSON Schema objeto válido — validar shape mínima.
const jsonSchemaParametersShape = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
}).passthrough();

// `entry` rejeita path traversal e absolute paths.
const safeEntryName = z.string()
  .max(64)
  .regex(/^[a-z0-9._-]+$/i, "entry must be a simple filename, no slashes or ..");

export const skillManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10).max(500),
  category: z.enum(["calendar", "messaging", "memory", "knowledge"]),
  agentType: z.enum(["pipeline", "surface", "both"]),
  parameters: jsonSchemaParametersShape,
  // V1: metadata apenas; evaluator atual não consome estes campos
  permissions: z.object({
    requires: z.array(z.string()).default([]),
    sideEffects: z.array(z.enum(["read", "write", "external_call", "stop_signal"])).default([]),
  }).default({ requires: [], sideEffects: [] }),
  entry: safeEntryName.default("index"),
}).strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
```

⚠ Em V1 os campos `permissions.requires`/`sideEffects` são **apenas metadata documental** — não são enforced pelo evaluator. Documentar isso explicitamente em `docs/architecture/skills.md`.

- [ ] **Step 2: Teste**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(skills): define skill manifest schema"
```

---

### Task 2: Skill Runtime (interface que skills implementam — usa ToolResult atual)

**Files:**
- Create: `src/skills/skill-runtime.ts`

- [ ] **Step 1: Definir interface SkillModule — reusa `ToolResult` existente sem modificá-lo**

```typescript
import type { AgentExecutionContext } from "../agents/execution-context";
import type { ToolResult } from "../tools/types";  // shape: { success, data?, error?, errorCode?, detail? }

export interface SkillModule {
  execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult>;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  module: SkillModule;
  manifestPath: string;
  /** Path absoluto do diretório da skill — para diagnósticos */
  skillDir: string;
}
```

⚠ **Stop signals são detectados por NOME da tool no loop de raciocínio** (`src/reasoning/*.ts` referencia `send-message` e `request-human` por nome). Para preservar comportamento: **manter os nomes exatos** ao registrar skills (`name: send-message` no manifest). Nenhuma alteração em `ToolResult` necessária — `data` pode conter `{ sent: true }` etc. conforme atual.

- [ ] **Step 2: Commit**

---

### Task 3: Skill Loader

**Files:**
- Create: `src/skills/skill-loader.ts`
- Create: `tests/unit/skills/skill-loader.test.ts`

- [ ] **Step 1: Instalar js-yaml**

```bash
npm install js-yaml
npm install --save-dev @types/js-yaml
```

- [ ] **Step 2: Implementar loader — CommonJS-compatible**

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import yaml from "js-yaml";
import { skillManifestSchema } from "./skill-manifest.schema";
import type { LoadedSkill, SkillModule } from "./skill-runtime";

export interface SkillLoaderOptions {
  /** Em prod, loader resolve de `dist/`; em dev, de `src/`. Inferido por NODE_ENV se omitido. */
  resolveFromDist?: boolean;
  /** Quando true, permite carregar skills fora do diretório built-in (cuidado!). */
  allowExternalPaths?: boolean;
}

// CommonJS module — `require` é global. Não usar `createRequire(import.meta.url)`:
// `import.meta` é ESM-only e `tsc` rejeita sob `module: "CommonJS"`.

export class SkillLoader {
  constructor(private opts: SkillLoaderOptions = {}) {}

  async loadFromPath(rootDir: string): Promise<LoadedSkill[]> {
    const absRoot = resolve(rootDir);
    const skills: LoadedSkill[] = [];
    const categories = await readdir(absRoot, { withFileTypes: true });

    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = join(absRoot, cat.name);
      const skillDirs = await readdir(catPath, { withFileTypes: true });

      for (const skillDir of skillDirs) {
        if (!skillDir.isDirectory()) continue;
        const skillPath = join(catPath, skillDir.name);
        try {
          const skill = await this.loadSkill(skillPath, absRoot);
          skills.push(skill);
        } catch (err) {
          throw new Error(`Failed to load skill at ${skillPath}: ${(err as Error).message}`);
        }
      }
    }
    return skills;
  }

  private async loadSkill(dir: string, rootDir: string): Promise<LoadedSkill> {
    const manifestPath = join(dir, "manifest.yaml");
    const raw = await readFile(manifestPath, "utf8");
    const parsed = yaml.load(raw);
    const manifest = skillManifestSchema.parse(parsed);

    // Path safety: entry deve estar dentro do diretório da skill (Zod já bloqueia `..` e `/`,
    // mas reforçamos aqui).
    if (isAbsolute(manifest.entry) || manifest.entry.includes("..")) {
      throw new Error(`Skill ${manifest.name}: entry rejected (path traversal)`);
    }

    // Resolver para .js (compilado) ou .ts (dev via tsx)
    const ext = process.env.NODE_ENV === "production" ? ".js" : ".ts";
    const entryFile = manifest.entry.endsWith(ext) ? manifest.entry : `${manifest.entry}${ext}`;
    const entryPath = resolve(dir, entryFile);

    // Verificar que entry resolvido está dentro do diretório da skill
    if (!entryPath.startsWith(resolve(dir) + require("node:path").sep)) {
      throw new Error(`Skill ${manifest.name}: entry escaped skill dir`);
    }

    // Dynamic CommonJS require — funciona em CJS sem precisar ESM
    // `tsx` intercepta `require` de .ts em dev. Em prod, lê do dist compilado.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const imported = require(entryPath);

    if (typeof imported.default?.execute !== "function" && typeof imported.execute !== "function") {
      throw new Error(`Skill ${manifest.name} must export default { execute } or { execute }`);
    }
    const module: SkillModule = imported.default ?? imported;

    return { manifest, module, manifestPath, skillDir: dir };
  }
}
```

⚠ **Decisão importante:** `tsx` (dev runtime) consegue interceptar `require()` de `.ts` files. Em prod (`node dist/index.js`), `tsc` deve ter compilado `src/skills-builtin/**` para `dist/skills-builtin/**`. Garantir em `tsconfig.json`:

```json
{
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

(Já é o caso — `src/skills-builtin/` cai dentro de `src/**/*`.)

- [ ] **Step 3: Testes (com fixtures de skills sintéticas em `tests/fixtures/skills/`)**

```typescript
it("loads valid skill from disk", async () => {
  const loader = new SkillLoader();
  const skills = await loader.loadFromPath("tests/fixtures/skills");
  expect(skills.length).toBeGreaterThan(0);
  expect(skills[0].manifest.name).toBeDefined();
});

it("rejects skill with invalid manifest", async () => {
  await expect(loader.loadFromPath("tests/fixtures/bad-skills"))
    .rejects.toThrow(/Failed to load/);
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(skills): add skill loader (yaml manifest + dynamic import)"
```

---

### Task 4: Skill Registry (substitui ToolRegistry)

**Files:**
- Create: `src/skills/skill-registry.ts`

- [ ] **Step 1: Manter API compatível com ToolRegistry atual**

```typescript
export class SkillRegistry {
  private static instance: SkillRegistry;
  private skills = new Map<string, LoadedSkill>();

  static getInstance() {
    return (this.instance ??= new SkillRegistry());
  }

  register(skill: LoadedSkill) {
    if (this.skills.has(skill.manifest.name)) {
      throw new Error(`Skill ${skill.manifest.name} already registered`);
    }
    this.skills.set(skill.manifest.name, skill);
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  list(): LoadedSkill[] {
    return Array.from(this.skills.values());
  }

  // Compat com ToolRegistry: ainda expor como "tools"
  asToolDefinitions(): ToolDefinition[] {
    return this.list().map((s) => ({
      name: s.manifest.name,
      description: s.manifest.description,
      category: s.manifest.category,
      agentType: s.manifest.agentType,
      parameters: s.manifest.parameters,
      execute: s.module.execute.bind(s.module),
    }));
  }
}
```

- [ ] **Step 2: Commit**

---

### Task 5: Migrar 1 tool de exemplo (send-message) para skill

**Files:**
- Create: `src/skills-builtin/messaging/send-message/manifest.yaml`
- Create: `src/skills-builtin/messaging/send-message/index.ts`
- Modify: `src/tools/messaging/send-message.tool.ts` (preservado durante coexistência; removido apenas no PR final da Task 6)

- [ ] **Step 1: `skills/messaging/send-message/manifest.yaml`**

```yaml
name: send-message
version: 1.0.0
description: Send a response message to the customer. STOP signal — reasoning loop halts after this is called.
category: messaging
agentType: surface
parameters:
  type: object
  required: [message]
  properties:
    message:
      type: string
      description: The text to send to the customer
permissions:
  requires: []
  sideEffects: [external_call, stop_signal]
entry: index
```

- [ ] **Step 2: `src/skills-builtin/messaging/send-message/index.ts` — espelha `src/tools/messaging/send-message.tool.ts` exatamente**

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context";
import type { ToolResult } from "../../../tools/types";
import * as bevoxCallback from "../../../integration/bevox-callback";

interface SendMessageParams {
  message: string;
}

export default {
  async execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult> {
    const p = params as SendMessageParams;
    if (!p.message) {
      return { success: false, error: "INVALID_PARAMS", detail: "message is required" };
    }
    try {
      const token = (context as AgentExecutionContext & { executionToken?: string }).executionToken ?? "";
      await bevoxCallback.sendComplete(context.executionId, token, {
        response: p.message,
      });
      return { success: true, data: { sent: true } };
    } catch (err) {
      return { success: false, error: "CALLBACK_ERROR", detail: String(err) };
    }
  },
};
```

- [ ] **Step 3: Teste de regressão**

```bash
npm test -- send-message
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(skills): migrate send-message tool to skill format"
```

---

### Task 6: Migrar os outros 12 tools — checklist explícito

**Estratégia de coexistência:** durante a migração, `src/tools/*` continua existindo e funcionando. Cada skill criada é **adicionalmente** registrada com nome `<name>-v2` ou em namespace separado, validada com testes paralelos, e só promovida (substituindo o nome canônico) quando todas as 12 estão prontas. Isso permite rollback trivial por revert de commit.

**Para cada tool abaixo:**
1. [ ] Ler `src/tools/<cat>/<name>.ts` — anotar shape exato de `ToolResult.data`, side effects, parâmetros aceitos
2. [ ] Criar `src/skills-builtin/<cat>/<name>/manifest.yaml` (JSON Schema espelhando params)
3. [ ] Criar `src/skills-builtin/<cat>/<name>/index.ts` (copiar lógica preservando comportamento 1:1)
4. [ ] Adicionar teste paralelo `tests/unit/skills/<name>.test.ts` que **roda exatamente os mesmos asserts** do teste tool atual (cobertura de regressão)
5. [ ] Rodar `npm test` — todos passam (testes antigos + novos)
6. [ ] Commit individual: `feat(skills): migrate <tool-name> to skill format`

**Pre-flight:** rodar `ls src/tools/**/*.tool.ts` para confirmar nomes reais antes de iniciar.

**Lista das 12 (arquivos confirmados, todos com sufixo `.tool.ts`):**

| # | Tool name | Arquivo atual | Side effects críticos a preservar |
|---|---|---|---|
| 1 | request-human | `src/tools/messaging/request-human.tool.ts` | Stop signal, callback |
| 2 | read-calendar | `src/tools/calendar/read-calendar.tool.ts` | Read-only |
| 3 | list-appointments | `src/tools/calendar/list-appointments.tool.ts` | Read-only |
| 4 | create-appointment | `src/tools/calendar/create-appointment.tool.ts` | POST Calendar Service |
| 5 | cancel-appointment | `src/tools/calendar/cancel-appointment.tool.ts` | DELETE Calendar Service |
| 6 | reschedule-appointment | `src/tools/calendar/reschedule-appointment.tool.ts` | PATCH Calendar Service |
| 7 | waitlist-add | `src/tools/calendar/waitlist-add.tool.ts` | POST Calendar Service |
| 8 | read-profile | `src/tools/memory/read-profile.tool.ts` | SELECT DB |
| 9 | write-profile | `src/tools/memory/write-profile.tool.ts` | UPDATE DB |
| 10 | write-fact | `src/tools/memory/write-fact.tool.ts` | INSERT DB |
| 11 | search-faq | `src/tools/knowledge/search-faq.tool.ts` | Lookup |
| 12 | send-message | `src/tools/messaging/send-message.tool.ts` (Task 5 já cobriu) | Stop signal, callback |

**Final da Task 6:** PR único que remove `src/tools/<cat>/*.tool.ts` e renomeia/promove skills para nomes canônicos. Antes do remove, verificar com `grep -rn "from.*tools/messaging/send-message" src/` que não há imports diretos remanescentes.

---

### Task 7: Bootstrap integration

**Files:**
- Modify: `src/bootstrap/05-load-tools-permissions.ts` (ou estágio equivalente)

- [ ] **Step 1: Substituir registro manual por loader — com gate de segurança em prod**

```typescript
import path from "node:path";
import { SkillLoader } from "../skills/skill-loader";
import { SkillRegistry } from "../skills/skill-registry";
import { getEnv } from "../config/env";

export async function loadSkillsStage(): Promise<void> {
  const env = getEnv();
  const loader = new SkillLoader();
  const registry = SkillRegistry.getInstance();

  // `__dirname` resolve para dist/bootstrap em prod (compilado) e src/bootstrap em dev (tsx).
  // Em ambos os casos, ../skills-builtin aponta para o irmão correto.
  const builtinRoot = path.resolve(__dirname, "../skills-builtin");

  const builtin = await loader.loadFromPath(builtinRoot);
  for (const s of builtin) registry.register(s);

  // Skills externas — opt-in EXPLÍCITO em produção
  if (env.SKILLS_PATH) {
    if (env.NODE_ENV === "production" && !env.ALLOW_EXTERNAL_SKILLS) {
      logger.warn(
        { SKILLS_PATH: env.SKILLS_PATH },
        "SKILLS_PATH ignored in production — set ALLOW_EXTERNAL_SKILLS=true to opt in",
      );
    } else {
      const external = await loader.loadFromPath(env.SKILLS_PATH);
      for (const s of external) registry.register(s);
      logger.warn({ count: external.length, path: env.SKILLS_PATH }, "external skills loaded — trusted boundary");
    }
  }

  logger.info({ count: registry.list().length }, "skills loaded");
}
```

- [ ] **Step 2: Adicionar env vars**

```typescript
SKILLS_PATH: z.string().optional(),
ALLOW_EXTERNAL_SKILLS: z.coerce.boolean().default(false),
```

- [ ] **Step 3: Atualizar permissões filter para ler de SkillRegistry**

- [ ] **Step 4: Testes — bootstrap completo com skills carregadas**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(skills): integrate skill loader into bootstrap"
```

---

### Task 8: Hot reload / disable skills (opcional para V1)

- [ ] **Step 1: Permitir desabilitar skills via env**

```typescript
SKILLS_DISABLED: z.string().transform((s) => new Set(s.split(",").filter(Boolean))).default(new Set()),
```

No loader, skip skills cujo nome está em `SKILLS_DISABLED`.

- [ ] **Step 2: Commit**

---

### Task 9: Documentação

**Files:**
- Create: `docs/architecture/skills.md`, `skills/README.md`

- [ ] **Step 1: `skills/README.md`** — como criar uma skill

```markdown
# Skills

Skills são tools plugáveis carregadas dinamicamente no bootstrap.

## Estrutura

```
src/skills-builtin/
  <category>/
    <skill-name>/
      manifest.yaml
      index.ts
      (opcional: tests, helpers)
```

(Compilado para `dist/skills-builtin/` em prod.)

## Manifest mínimo

```yaml
name: minha-skill
version: 1.0.0
description: O que ela faz (mínimo 10 chars)
category: messaging  # calendar | messaging | memory | knowledge
agentType: surface   # pipeline | surface | both
parameters:
  type: object
  required: []
  properties: {}
permissions:
  requires: []
  sideEffects: []
entry: index
```

(Schema defaulta `entry: index` sem extensão; loader resolve `.ts` em dev e `.js` em prod.)

## Implementação

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context";
import type { ToolResult } from "../../../tools/types";

export default {
  async execute(params: unknown, ctx: AgentExecutionContext): Promise<ToolResult> {
    return { success: true, data: { /* dados específicos da tool */ } };
  }
};
```

ToolResult sempre `{ success, data?, error?, errorCode?, detail? }`. Stop signals (`send-message`, `request-human`) são detectados pelo loop de raciocínio via **nome** da tool, não via campo no result.

## Skills externas

Defina `SKILLS_PATH=/caminho/para/skills` no `.env`. Skills carregadas após as built-in; conflito de nome falha o bootstrap.
```

- [ ] **Step 2: `docs/architecture/skills.md`** — design rationale, segurança, evolução

- [ ] **Step 3: Commit + PR final**

---

## Definition of Done

- ✅ 13 tools migradas para `src/skills-builtin/`
- ✅ Bootstrap carrega skills built-in + externas (com gate `ALLOW_EXTERNAL_SKILLS` em prod)
- ✅ Todos os testes existentes passam sem alteração
- ✅ Manifest validado por Zod (rejeita malformado, path traversal)
- ✅ Skills externas via `SKILLS_PATH` carregadas com sucesso em integração (dev)
- ✅ Permissões aplicadas a skills carregadas dinamicamente
- ✅ **Smoke test de CJS resolution (prod):** `npm run build && node -e "require('./dist/skills-builtin/messaging/send-message')"` retorna sem erro
- ✅ **Smoke test dev (tsx):** `npm run dev` boota com skills carregadas de `src/skills-builtin/`
- ✅ Documentação publicada

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Skill maliciosa via `SKILLS_PATH` executa código arbitrário | Loader rejeita `entry` com `..` ou `/`; em prod requer `ALLOW_EXTERNAL_SKILLS=true` explícito; documentar como **trusted boundary** |
| `tsc` não compila skills built-in | Skills ficam em `src/skills-builtin/**` que já está em `include: ["src/**/*"]` — testar com `npm run build && ls dist/skills-builtin/` |
| Tool result shape drift quebra regressão | Task 6 obriga teste paralelo replicando asserts; ToolResult não muda |
| Coexistência tools+skills causa registro duplicado | Skills registradas com sufixo `-v2` durante migração; promoção em PR final |
| Conflito de nomes entre skills externas e built-in | Bootstrap falha explicitamente; documentar namespacing convention |
| Regressão silenciosa após migração | Cobertura de testes da Fase 2 (≥70%) obrigatória antes de iniciar Fase 8 |
| Performance de require dynamic | Negligível (<50ms para 13 skills); medir se preocupar |
