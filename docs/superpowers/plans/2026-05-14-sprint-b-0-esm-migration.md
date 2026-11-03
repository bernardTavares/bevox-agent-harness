# Sprint B.0: ESM Migration — Plano de Implementação

> **Para agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar este plano task-by-task. Steps usam checkbox (`- [ ]`) para tracking.

**Goal:** Migrar o projeto de CommonJS para ESM (`module: NodeNext`) preservando comportamento runtime. Pré-requisito obrigatório para Sprint B.1 (MCP Server) e B.2 (MCP Client), que dependem do SDK `@modelcontextprotocol/sdk@1.x` (ESM-only).

**Architecture:** Mudança de `tsconfig.json` + `package.json` + adição de extensão `.js` em imports relativos + substituição de patterns CJS (`__dirname`, `__filename`, `require`) por equivalentes ESM (`import.meta.url`, `createRequire`). Sem mudança de comportamento runtime — todo código continua executável; só o módulo system muda.

**Tech Stack:** TypeScript 5.9 (NodeNext), Node 20+, scripts de codemod (Node `.mjs`) para automação em massa.

---

## Dependencies

- **Hard:** Nenhuma. É a fase base do Sprint B.
- **Soft:** Phase 1 CI/CD (workflows verdes) — para validar migração end-to-end no CI.
- **Blocks (esta fase libera):**
  - Sprint B.1 MCP Server
  - Sprint B.2 MCP Client
  - Qualquer dep futura ESM-only (Mastra packages, `@mastra/mcp`, `p-timeout@6`, etc.)

## Files Touched

### Create
- `scripts/esm-migration-add-extensions.mjs` (codemod single-purpose para adicionar `.js` em imports relativos)
- `scripts/esm-migration-replace-cjs-patterns.mjs` (codemod para `__dirname`/`__filename`/`require`)
- `docs/architecture/esm-migration-notes.md` (notas operacionais — opcional, segue política bevox-knowledge SoT)

### Modify
- `tsconfig.json` — `module: NodeNext`, `moduleResolution: NodeNext`, manter `target: ES2022`
- `package.json` — adicionar `"type": "module"`; ajustar scripts se necessário; verificar campos `main`/`exports`
- `vitest.config.ts` — confirmar compatibilidade ESM (Vitest 4 é ESM-native, mas validar)
- `src/**/*.ts` — adicionar `.js` em ~266 imports relativos (automatizado via codemod)
- `src/bootstrap/stages.ts` — substituir `__dirname` por `path.dirname(fileURLToPath(import.meta.url))`
- `src/skills/skill-loader.ts` — `createRequire(__filename)` → `createRequire(import.meta.url)`
- `src/integration/llm/credential-pool.ts` — `require()` lazy → dynamic `import()` ou `createRequire`
- `scripts/copy-skill-manifests.js` — verificar se script standalone funciona como ESM (renomear para `.mjs` se necessário)
- `scripts/dev-up.mjs`, `scripts/dev-down.mjs`, `scripts/migrate.mjs`, `scripts/enqueue-test-job.mjs` — já são `.mjs`, validar imports

### High-conflict files
- ⚠️ `tsconfig.json` — qualquer outra fase tocando aqui colide com B.0; mergear B.0 PRIMEIRO antes de Sprint B/C/D
- ⚠️ `package.json` — sempre minado; B.0 só toca `"type"` + scripts mínimos, mergear primeiro
- 🚨 `src/**/*.ts` — TODOS os arquivos `.ts` afetados pela adição de `.js` em imports relativos; é uma "lava" grande de diffs mas mecânica

## Estimated Effort

**1-2 dias de trabalho focado (8-16 horas).** A maioria é automatizada via codemod; o esforço real está em validação + correção de edge cases.

---

## Tasks

### Task 0: Husky e ambiente

**Contexto:** Husky pre-commit/commit-msg quebrado no Windows (sem shebang, dá `Exec format error`). Memory `feedback_husky_broken_windows.md`.

- [ ] **Step 1:** Confirmar que `git commit --no-verify` será usado para todos os commits deste sprint
- [ ] **Step 2:** Rodar `npm run lint && npm test && npm run build` manualmente ANTES de cada commit
- [ ] **Step 3:** Documentar no PR descrição: "ESM migration — Husky bypass usado por questão de ambiente Windows; lint+test validados manualmente em cada commit"

---

### Task 1: Branch preparatório e snapshot do estado atual

**Files:**
- (nenhum modificado nesta task)

- [ ] **Step 1: Criar branch a partir de `main`**
```bash
git checkout main
git pull origin main
git checkout -b sprint-b-0-esm-migration
```

- [ ] **Step 2: Capturar baseline do build atual**
```bash
npm run build
npm test 2>&1 | tee /tmp/baseline-tests.txt
npm run lint 2>&1 | tee /tmp/baseline-lint.txt
```
Salvar contagens esperadas: tests passing, lint errors, warnings, build success. Vão ser referência para validar pós-migração.

- [ ] **Step 3: Tag local para rollback emergencial**
```bash
git tag pre-esm-migration
```

Esperado: 0 errors, 480+ tests passing, `npm run build` clean.

---

### Task 2: Mudar `tsconfig.json` para NodeNext

**Files:**
- Modify: `tsconfig.json`

- [ ] **Step 1: Substituir `module` e `moduleResolution`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Não mexer:** `target`, `rootDir`, `outDir`, `strict`, `esModuleInterop`, `skipLibCheck`.

- [ ] **Step 2: Tentar `npm run build` — vai falhar com centenas de erros TS2835/TS2307**

```bash
npm run build 2>&1 | head -30
```

Esperado: erros como:
```
src/agents/pipeline/memory-extractor.agent.ts:3:42 - error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Consider adding an extension to the import path.
```

Isso é esperado — Task 4 corrige. NÃO commitar ainda.

- [ ] **Step 3: Verificar contagem aproximada de erros**
```bash
npm run build 2>&1 | grep "TS2835" | wc -l
```
Esperado: ~266 (conforme grep inicial).

---

### Task 3: Adicionar `"type": "module"` em `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Adicionar campo `"type"` no topo (após `"private"`)**

```json
{
  "name": "bevox-agent-harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { ... }
}
```

- [ ] **Step 2: Verificar se algum script CLI standalone quebra**
```bash
node scripts/migrate.mjs --help 2>&1 || echo "migrate.mjs OK (já é .mjs, type:module não afeta)"
node scripts/copy-skill-manifests.js 2>&1 || echo "VERIFICAR: copy-skill-manifests.js pode precisar virar .mjs"
```

- [ ] **Step 3: Se `copy-skill-manifests.js` quebrar, renomear para `.mjs`**

```bash
git mv scripts/copy-skill-manifests.js scripts/copy-skill-manifests.mjs
```

Atualizar referência no `package.json`:
```json
"build": "tsc && node scripts/copy-skill-manifests.mjs"
```

E confirmar imports internos do script já são compatíveis ESM.

- [ ] **Step 4:** NÃO commitar ainda. Tasks 4-5 precisam acontecer juntas para o build voltar a passar.

---

### Task 4: Codemod — adicionar `.js` em imports relativos

**Files:**
- Create: `scripts/esm-migration-add-extensions.mjs`

**Estratégia:** AST-level transformation via Babel parser para evitar quebrar strings e comentários que casam regex.

- [ ] **Step 1: Instalar deps temporárias para o codemod**

```bash
npm install --save-dev --no-audit --ignore-scripts @babel/parser @babel/traverse @babel/generator @babel/types
```

(Serão removidas após codemod rodar.)

- [ ] **Step 2: Criar `scripts/esm-migration-add-extensions.mjs`**

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const SRC_ROOT = resolve("src");

async function* walkTs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

function shouldRewrite(importPath, fromFile) {
  // Skip non-relative
  if (!importPath.startsWith(".")) return null;
  // Already has extension
  if (/\.(js|json|mjs|cjs)$/.test(importPath)) return null;
  // Resolve target — does it exist as .ts file?
  const candidates = [
    `${importPath}.ts`,
    `${importPath}/index.ts`,
  ];
  for (const c of candidates) {
    const abs = resolve(dirname(fromFile), c);
    try {
      const s = statSync(abs);
      if (s.isFile()) {
        // It's a TS file — replace with .js suffix
        return c.endsWith("/index.ts") ? `${importPath}/index.js` : `${importPath}.js`;
      }
    } catch {
      /* not found */
    }
  }
  return null;
}

let totalChanges = 0;
let filesChanged = 0;

for await (const file of walkTs(SRC_ROOT)) {
  const code = readFileSync(file, "utf8");
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "decorators-legacy"],
  });
  let changed = false;

  traverse(ast, {
    ImportDeclaration(path) {
      const src = path.node.source.value;
      const rewritten = shouldRewrite(src, file);
      if (rewritten) {
        path.node.source.value = rewritten;
        changed = true;
        totalChanges++;
      }
    },
    ExportAllDeclaration(path) {
      if (!path.node.source) return;
      const src = path.node.source.value;
      const rewritten = shouldRewrite(src, file);
      if (rewritten) {
        path.node.source.value = rewritten;
        changed = true;
        totalChanges++;
      }
    },
    ExportNamedDeclaration(path) {
      if (!path.node.source) return;
      const src = path.node.source.value;
      const rewritten = shouldRewrite(src, file);
      if (rewritten) {
        path.node.source.value = rewritten;
        changed = true;
        totalChanges++;
      }
    },
  });

  if (changed) {
    const out = generate(ast, { retainLines: true, jsescOption: { quotes: "double" } }, code).code;
    writeFileSync(file, out, "utf8");
    filesChanged++;
  }
}

console.log(`ESM migration: ${totalChanges} imports rewritten across ${filesChanged} files`);
```

- [ ] **Step 3: Rodar codemod**

```bash
node scripts/esm-migration-add-extensions.mjs
```

Esperado: log "X imports rewritten across Y files" (X ≈ 266, Y ≈ 50-70 arquivos).

- [ ] **Step 4: Sanity-check em arquivos representativos**

```bash
head -10 src/agents/pipeline/memory-extractor.agent.ts
head -10 src/runtime/execution-handler.ts
```

Verificar manualmente:
- Imports relativos terminam com `.js` (não `.ts`)
- Imports `node:*` e packages `bullmq`/`pg`/etc inalterados
- Não há `.js.js` (double-suffix bug)

- [ ] **Step 5: Tentar `npm run build`**

```bash
npm run build 2>&1 | head -30
```

Esperado: TS2835 zerou. Podem aparecer outros erros (TS2307 module not found para imports tipo-only que apontam para `.d.ts`, ou erros em arquivos com `__dirname`/`require`). Task 5 trata.

---

### Task 5: Substituir patterns CJS por equivalentes ESM

**Files:**
- Modify: `src/bootstrap/stages.ts`
- Modify: `src/skills/skill-loader.ts`
- Modify: `src/integration/llm/credential-pool.ts`

- [ ] **Step 1: `src/bootstrap/stages.ts` — substituir `__dirname`**

Localizar bloco que monta `builtinRoot` (linha ~164):

```typescript
// ANTES (CJS):
const builtinRoot = path.resolve(__dirname, "..", "skills-builtin");

// DEPOIS (ESM):
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const builtinRoot = path.resolve(__dirname, "..", "skills-builtin");
```

Idealmente extrair o boilerplate `__dirname`/`__filename` para um helper `src/utils/esm-paths.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export function getDirname(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}
```

E usar: `const __dirname = getDirname(import.meta.url);`

- [ ] **Step 2: `src/skills/skill-loader.ts` — `createRequire(__filename)` → `createRequire(import.meta.url)`**

```typescript
// ANTES:
const localRequire = createRequire(__filename);

// DEPOIS:
const localRequire = createRequire(import.meta.url);
```

Sem mudar nada além disso. `createRequire` aceita URL direto.

- [ ] **Step 3: `src/integration/llm/credential-pool.ts` — `require()` lazy**

Atualmente:
```typescript
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getEnv } = require("../../config/env") as typeof import("../../config/env");
```

Em ESM, `require` não existe. Duas opções:

**Opção A — `createRequire`** (mantém sync, igual ao atual):
```typescript
import { createRequire } from "node:module";
const requireCjs = createRequire(import.meta.url);
// dentro de getCredentialPool():
const { getEnv } = requireCjs("../../config/env.js");
```

**Opção B — Dynamic import** (idiomático ESM, mas torna `getCredentialPool` async):
```typescript
// muda getCredentialPool para async ou usa top-level await
const { getEnv } = await import("../../config/env.js");
```

**Recomendado:** Opção A. Manter sync evita refator de todos os call sites de `getCredentialPool()`.

- [ ] **Step 4: Rodar `npm run build`**

```bash
npm run build 2>&1 | tail -20
```

Esperado: 0 errors. Build clean.

Se ainda houver erros TS2307 (module not found), verificar:
- Imports apontando para arquivos `.d.ts`-only (deveriam usar `import type` sem `.js`, ou ter `.d.ts` separado)
- Imports para `node:*` corretos
- Imports para packages externos com `package.json#exports` problemático (raro, mas pode acontecer com lib ESM/CJS misturada)

---

### Task 6: Validar testes Vitest

**Files:**
- (potencialmente `vitest.config.ts` se algo precisar de ajuste)

- [ ] **Step 1: Rodar suite completa**

```bash
npm test 2>&1 | tail -10
```

Esperado: 480+ tests passing, mesma contagem do baseline.

- [ ] **Step 2: Se algum teste falhar com `Cannot find module`**

Causa provável: o teste importa de `src/` com path relativo sem `.js`. Tests também precisam ser rewritten — rodar codemod sobre `tests/`:

```bash
# Editar codemod: SRC_ROOT = resolve("tests"); rerun
node scripts/esm-migration-add-extensions.mjs  # após editar
```

Ou criar variante específica para tests. Reinstalar deps `@babel/*` removidas se necessário.

- [ ] **Step 3: Se algum teste falhar com `__dirname is not defined`**

Aplicar mesmo fix do Task 5 nos arquivos de teste afetados.

- [ ] **Step 4: Validar testes com coverage**

```bash
npm run test:coverage 2>&1 | tail -10
```

Esperado: cobertura igual ou superior ao baseline (82% lines).

---

### Task 7: Validar lint e formatter

- [ ] **Step 1: Rodar lint**

```bash
npm run lint 2>&1 | tail -3
```

Esperado: 0 errors, ~66 warnings (mesmo do baseline, ou menos — alguns `no-require-imports` agora resolvidos).

- [ ] **Step 2: Rodar format:check**

```bash
npm run format:check 2>&1 | tail -5
```

Esperado: todos os arquivos OK. Se algo desformatou via codemod:
```bash
npm run format
git diff --stat
```

Confirmar que mudanças são só whitespace, não conteúdo.

- [ ] **Step 3: Rodar typecheck explicitamente**

```bash
npm run typecheck 2>&1 | tail -3
```

Esperado: clean.

---

### Task 8: Remover dependências de codemod e commitar

- [ ] **Step 1: Remover deps temporárias do codemod**

```bash
npm uninstall @babel/parser @babel/traverse @babel/generator @babel/types --no-audit --ignore-scripts
```

- [ ] **Step 2: Verificar lockfile**

```bash
git diff package.json package-lock.json | head -30
```

Esperado: `"type": "module"` adicionado, `@babel/*` ausentes. Lockfile sem `@babel/*`.

- [ ] **Step 3: Commitar em chunks lógicos**

```bash
# Chunk 1: config files
git add tsconfig.json package.json package-lock.json
git commit --no-verify -m "build: migrate to ESM (NodeNext module resolution)"

# Chunk 2: imports com .js (massive diff mas mecânico)
git add "src/**/*.ts"
git commit --no-verify -m "refactor(esm): add .js extension to relative imports (codemod)"

# Chunk 3: CJS patterns substituídos
git add src/bootstrap/stages.ts src/skills/skill-loader.ts src/integration/llm/credential-pool.ts
git commit --no-verify -m "refactor(esm): replace __dirname/__filename/require with import.meta equivalents"

# Chunk 4: codemod scripts (committar para reuso futuro)
git add scripts/esm-migration-add-extensions.mjs
git commit --no-verify -m "chore(scripts): add ESM migration codemod for future reference"
```

- [ ] **Step 4: Re-rodar suite final**

```bash
npm run lint && npm test && npm run build
```

Esperado: tudo verde.

---

### Task 9: Verificar CI no GitHub Actions

- [ ] **Step 1: Push para branch**

```bash
git push origin sprint-b-0-esm-migration
```

- [ ] **Step 2: Abrir PR**

```bash
gh pr create --title "Sprint B.0: ESM migration (unblocks B.1 + B.2)" --body-file docs/superpowers/plans/2026-05-14-sprint-b-0-esm-migration.md
```

- [ ] **Step 3: Watch CI**

```bash
gh pr checks --watch
```

Esperado: 4 workflows verdes (CI, Security, CodeQL, Release).

- [ ] **Step 4: Se algum workflow falhar**

Triagem por workflow:
- **CI:** geralmente é variação de `npm install` em Linux com lockfile gerado em Windows — já resolvido em memory `feedback_ci_npm_install.md`. Se aparecer, confirmar que workflows usam `npm install --no-audit --no-fund --ignore-scripts` e não `npm ci`.
- **Security:** OSV/npm audit não deve ser afetado pela migração.
- **CodeQL:** análise JS/TS pode ter divergências; investigar caso a caso.
- **Release:** changesets não afetado.

---

### Task 10: Documentar mudança e atualizar memory

- [ ] **Step 1: Atualizar `CLAUDE.md` na seção "Stack"**

Encontrar bloco:
```markdown
- **Runtime**: Node.js 20+, TypeScript 5.9
```

Adicionar nota:
```markdown
- **Runtime**: Node.js 20+, TypeScript 5.9 (ESM/NodeNext desde Sprint B.0)
```

- [ ] **Step 2: Adicionar memory de projeto sobre ESM (via skill bevox-knowledge-contribute ou local)**

Conteúdo sugerido:

```markdown
---
name: project-uses-esm-nodenext
description: Projeto migrou para ESM (NodeNext) em Sprint B.0 — imports relativos precisam de .js extension
metadata:
  type: project
---

Desde 2026-05-14 (Sprint B.0), projeto usa `module: NodeNext` em `tsconfig.json` e `"type": "module"` em `package.json`.

**How to apply:**
- Novos imports relativos DEVEM ter `.js` (não `.ts`): `import { x } from "./foo.js"`
- Imports de packages externos / `node:*` sem extensão
- Em vez de `__dirname`/`__filename`, usar helper `getDirname(import.meta.url)` ou inline `fileURLToPath`
- `require()` proibido — usar `createRequire(import.meta.url)` se sync sync necessário OU dynamic `import()`
- Codemod disponível: `scripts/esm-migration-add-extensions.mjs` para batches de adição de `.js`
```

- [ ] **Step 3: Atualizar `feedback_husky_broken_windows.md` se aplicável**

Husky pode ter ficado MAIS quebrado se algum hook usava CJS. Validar pré-commit hook funciona ainda (mesmo que continue a ser bypassed via `--no-verify`).

- [ ] **Step 4: Commitar docs**

```bash
git add CLAUDE.md
# memory files são commitados localmente em ~/.claude/projects/...
git commit --no-verify -m "docs: note ESM migration in CLAUDE.md"
```

---

## Definition of Done

- ✅ `tsconfig.json` com `module: NodeNext`, `moduleResolution: NodeNext`
- ✅ `package.json` com `"type": "module"`
- ✅ Todos os imports relativos em `src/` e `tests/` terminam com `.js`
- ✅ `__dirname`/`__filename`/`require()` substituídos por equivalentes ESM (3 arquivos identificados)
- ✅ `npm run build` clean (0 errors)
- ✅ `npm test` mesmo número de testes passando vs baseline (480+)
- ✅ `npm run test:coverage` mantém ≥ 82% lines
- ✅ `npm run lint` 0 errors (warnings podem ter mudado)
- ✅ `npm run format:check` clean
- ✅ CI verde no PR (4 workflows: CI, Security, CodeQL, Release)
- ✅ Codemod committado em `scripts/` para reuso futuro
- ✅ Mudança documentada em `CLAUDE.md` e memory

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Codemod adiciona `.js` em import que aponta para `.d.ts` (não existe `.ts`) | Codemod testa existência do `.ts` antes de rewrite (linha `statSync` em `shouldRewrite`); imports tipo-only só com `.d.ts` precisam mudança manual |
| Lockfile gerado em Windows quebra `@babel/*` em CI | Codemod só roda local; `@babel/*` removido antes do commit final, então lockfile final está limpo |
| `vitest.config.ts` precisa de ajuste para ESM | Vitest 4 é ESM-native, deve funcionar; se não, mudar arquivo para `.mts` e ajustar config |
| Algum tooling 3rd-party assume CJS (ex: `tsx` em modo dev) | `tsx` v4 suporta ESM nativo via `--esm` flag ou via `package.json#type`; validar `npm run dev` no fim |
| Hot reload do `tsx watch` falha após migração | Restartar dev server; se persistir, alternativa é `node --watch dist/index.js` após build |
| `scripts/copy-skill-manifests.js` quebra como CJS num projeto ESM | Renomear para `.mjs` (Task 3 Step 3) |
| Suspended workflows (C.1, futuro) com state JSONB resumem após migração | N/A — B.0 é antes de C.1; sem state ainda |
| Outros sprints em paralelo travam por conflito em `tsconfig.json`/`package.json` | B.0 deve ser merged antes de qualquer Sprint A/B/C/D que toque essas configs |
| ESLint config quebra com `eslint.config.mjs` em projeto ESM | `eslint.config.mjs` já é ESM; deveria funcionar mais limpo após `"type": "module"` |
| Pacote `commander` (se A.2 ainda precisar) é CJS — incompat | A.2 já substituído por `node:util` `parseArgs` (correção pós-review); irrelevante |

## Notas para Sprint B.1 e B.2

Após B.0 merged, B.1 e B.2 podem usar `@modelcontextprotocol/sdk@1.x` imports nativos:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

Sem `require()`, sem `await import()` dinâmico. As correções dos planos B.1/B.2 que falavam em "usar `await import()` enquanto B.0 não merged" ficam obsoletas — voltar para imports estáticos.
