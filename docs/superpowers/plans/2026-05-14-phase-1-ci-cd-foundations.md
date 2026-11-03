# Phase 1: CI/CD Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establecer a fundação de qualidade automatizada (lint, format, typecheck, testes, scanners de segurança) executando em PRs e push para `main`, inspirado em práticas do Hermes Agent.

**Architecture:** GitHub Actions com matrix de jobs (lint, typecheck, test, audit), ESLint + Prettier configurados com regras consistentes, Husky + lint-staged para pre-commit local. OSV Scanner e `npm audit` em workflow separado. Sem alteração no código-fonte da aplicação.

**Tech Stack:** GitHub Actions, ESLint 9 (flat config), Prettier 3, Husky 9, lint-staged 15, OSV Scanner (Google), commitlint, conventional-changelog.

---

## Dependencies

- **Hard:** Nenhuma. Esta é a fase base.
- **Soft:** Nenhuma.
- **Blocks (esta fase libera):**
  - Fase 2 (testes precisam de CI para rodar automaticamente)
  - Fase 6 (releases dependem do CI verde)
  - Conventional commits (Fase 6) reaproveitam commitlint daqui

## Files Touched

### Create
- `.github/workflows/ci.yml`
- `.github/workflows/security.yml`
- `.github/workflows/codeql.yml`
- `.github/CODEOWNERS`
- `.github/pull_request_template.md`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/dependabot.yml`
- `.env.ci` (stub env vars para job de teste)
- `eslint.config.mjs` (ESM — `.mjs` para evitar conflito com `package.json` CommonJS)
- `.prettierrc.json`
- `.prettierignore`
- `.editorconfig`
- `.husky/pre-commit`
- `.husky/commit-msg`
- `commitlint.config.js`
- `.nvmrc`

### Modify
- `package.json` (scripts: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`, `prepare`; devDependencies)
- `.gitignore` (adicionar `.husky/_`)
- `README.md` (seção "Development > Setup")

### High-conflict files
- ⚠️ `package.json` — qualquer outra fase tocando em deps/scripts vai conflitar
- ⚠️ `.github/workflows/*` — conflita com Fase 6 (release.yml)

## Estimated Effort
1-2 dias de trabalho focado (8-12 horas).

---

## Tasks

### Task 1: Adicionar `.nvmrc` e `.editorconfig`

**Files:**
- Create: `.nvmrc`
- Create: `.editorconfig`

- [ ] **Step 1: Criar `.nvmrc`**

Conteúdo (uma linha):
```
20
```

- [ ] **Step 2: Criar `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 3: Commit**

```bash
git add .nvmrc .editorconfig
git commit -m "chore: add nvmrc and editorconfig"
```

---

### Task 2: Configurar Prettier

**Files:**
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `package.json` (scripts + devDependencies)

- [ ] **Step 1: Instalar Prettier**

```bash
npm install --save-dev --save-exact prettier@3
```

- [ ] **Step 2: Criar `.prettierrc.json`**

```json
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": false,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **Step 3: Criar `.prettierignore`**

```
dist/
coverage/
node_modules/
*.lock
*.log
.husky/_/
```

- [ ] **Step 4: Adicionar scripts em `package.json`**

```json
"format": "prettier --write \"src/**/*.{ts,js,json}\" \"*.{md,json,yml,yaml}\"",
"format:check": "prettier --check \"src/**/*.{ts,js,json}\" \"*.{md,json,yml,yaml}\""
```

- [ ] **Step 5: Rodar format uma vez para alinhar baseline**

```bash
npm run format
```

- [ ] **Step 6: Verificar — não deve haver erros**

```bash
npm run format:check
```
Expected: `All matched files use Prettier code style!`

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: add prettier with project-wide formatting"
```

---

### Task 3: Configurar ESLint (flat config)

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json`

- [ ] **Step 1: Instalar ESLint e plugins**

```bash
npm install --save-dev eslint@9 typescript-eslint@8 eslint-config-prettier@9 eslint-plugin-import@2
```

- [ ] **Step 2: Criar `eslint.config.mjs`** (flat config, ESM explícito — `.mjs` porque `package.json` não tem `"type": "module"`)

```javascript
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "*.config.js"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "import/order": ["error", {
        "newlines-between": "always",
        "alphabetize": { "order": "asc" }
      }],
      "no-console": ["warn", { "allow": ["warn", "error"] }],
    },
  },
  // Relax type-aware rules em arquivos de teste para evitar falsos positivos
  // com vitest globals e fakes (Vitest 4 imports são explícitos, então não precisa de globals types).
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  prettier,
];
```

⚠ **Nota:** `package.json` já tem `"lint": "eslint src/"`. Substituir pela versão acima (com glob explícito).

- [ ] **Step 3: Adicionar scripts em `package.json`**

```json
"lint": "eslint \"src/**/*.ts\"",
"lint:fix": "eslint --fix \"src/**/*.ts\"",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 4: Rodar lint — esperado: pode haver erros existentes**

```bash
npm run lint
```

- [ ] **Step 5: Corrigir erros críticos (no-floating-promises, no-misused-promises)**

Estes são bugs reais. Outros warnings podem ficar para PR de seguimento.

- [ ] **Step 6: Re-rodar lint até passar (com warnings aceitáveis)**

```bash
npm run lint
```
Expected: 0 errors. Warnings permitidos.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: add eslint flat config with type-aware rules"
```

---

### Task 4: Configurar Husky + lint-staged + commitlint

**Files:**
- Create: `.husky/pre-commit`
- Create: `.husky/commit-msg`
- Create: `commitlint.config.mjs` (ESM — projeto é CommonJS, `.js` com `export default` falha)
- Modify: `package.json`

- [ ] **Step 1: Instalar dependências**

```bash
npm install --save-dev husky@9 lint-staged@15 @commitlint/cli @commitlint/config-conventional
```

- [ ] **Step 2: Adicionar script `prepare` e config `lint-staged` em `package.json`**

```json
"scripts": {
  "prepare": "husky"
},
"lint-staged": {
  "*.ts": [
    "eslint --fix",
    "prettier --write"
  ],
  "*.{json,md,yml,yaml}": [
    "prettier --write"
  ]
}
```

- [ ] **Step 3: Inicializar Husky**

```bash
npm run prepare
```

- [ ] **Step 4: Criar `.husky/pre-commit`**

```bash
npx lint-staged
```

Tornar executável (no Windows não importa, no Unix sim):
```bash
chmod +x .husky/pre-commit 2>/dev/null || true
```

- [ ] **Step 5: Criar `commitlint.config.mjs`** (ESM extension porque projeto é CommonJS)

```javascript
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", [
      "feat", "fix", "docs", "style", "refactor", "perf",
      "test", "build", "ci", "chore", "revert"
    ]],
    "subject-case": [0],
  },
};
```

- [ ] **Step 6: Criar `.husky/commit-msg`**

```bash
npx --no-install commitlint --edit "$1"
```

- [ ] **Step 7: Testar pre-commit com commit válido**

```bash
git add .
git commit -m "chore: add husky pre-commit and commitlint"
```
Expected: lint-staged roda, commitlint valida, commit passa.

- [ ] **Step 8: Testar commit-msg com mensagem inválida (validação negativa)**

```bash
git commit --allow-empty -m "mensagem ruim sem type"
```
Expected: commitlint rejeita. Após confirmar bloqueio, descartar empty commit.

---

### Task 5: GitHub Actions — workflow principal de CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Criar `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check

  typecheck:
    name: TypeScript
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run typecheck

  test:
    name: Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: bevox_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm test
        env:
          # Stub vars necessárias para Zod env schema passar em getEnv()
          DATABASE_URL: postgres://postgres:test@localhost:5432/bevox_test
          REDIS_URL: redis://localhost:6379
          OPENAI_API_KEY: sk-test-stub
          BEVOX_CALLBACK_BASE_URL: http://localhost:3000
          CALENDAR_SERVICE_URL: http://localhost:3009/api
          DEFAULT_LLM_PROVIDER: openai
          DEFAULT_LLM_MODEL: gpt-4o-mini
          HARNESS_QUEUE_NAME: execution.dispatch.agent_harness
          HARNESS_MAX_EXECUTION_TIME_MS: "120000"
          HARNESS_LOG_LEVEL: error

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
```

- [ ] **Step 2: Commit (não há como testar localmente sem push)**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add main CI workflow (lint, typecheck, test, build)"
```

- [ ] **Step 3: Push para branch de teste e verificar Actions**

```bash
git push origin HEAD:ci-foundations-test
gh pr create --title "ci: foundations" --body "Validating CI pipeline"
```
Expected: 4 jobs verdes. Se falhar, ajustar e iterar.

---

### Task 6: Workflow de segurança (OSV Scanner + npm audit)

**Files:**
- Create: `.github/workflows/security.yml`

- [ ] **Step 1: Criar `.github/workflows/security.yml`**

```yaml
name: Security

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"

jobs:
  osv-scanner:
    name: OSV Scanner
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: google/osv-scanner-action@v1
        with:
          scan-args: |-
            --lockfile=./package-lock.json
            --format=sarif
            --output=osv-results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: osv-results.sarif

  npm-audit:
    name: npm audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm audit --audit-level=high
        continue-on-error: false
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/security.yml
git commit -m "ci: add OSV scanner and npm audit workflow"
```

---

### Task 7: CodeQL workflow

**Files:**
- Create: `.github/workflows/codeql.yml`

- [ ] **Step 1: Criar `.github/workflows/codeql.yml`**

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 2"

jobs:
  analyze:
    name: Analyze TypeScript
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/codeql.yml
git commit -m "ci: add CodeQL static analysis"
```

---

### Task 8: Dependabot, CODEOWNERS, PR/Issue templates

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/CODEOWNERS`
- Create: `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`

- [ ] **Step 1: Criar `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      types:
        patterns: ["@types/*"]
      dev:
        dependency-type: development
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: monthly
```

- [ ] **Step 2: Criar `.github/CODEOWNERS`**

```
* @bernardTavares
```

(Ajustar conforme equipe real.)

- [ ] **Step 3: Criar `.github/pull_request_template.md`**

```markdown
## What

<!-- 1-2 sentences: o que esse PR muda? -->

## Why

<!-- Contexto / motivação. Link de issue, se houver. -->

## How to test

- [ ] Tests added/updated
- [ ] Manual verification:

## Checklist

- [ ] `npm run lint` passa
- [ ] `npm run typecheck` passa
- [ ] `npm test` passa
- [ ] Commits seguem convencional (feat/fix/chore/...)
```

- [ ] **Step 4: Criar templates de issue (bug + feature)**

`.github/ISSUE_TEMPLATE/bug_report.md`:
```markdown
---
name: Bug report
about: Reportar um bug
labels: bug
---

**Descrição**
<!-- O que aconteceu? -->

**Reprodução**
1.
2.
3.

**Comportamento esperado**

**Logs / stack trace**

**Ambiente**
- Node: 
- OS: 
```

`.github/ISSUE_TEMPLATE/feature_request.md`:
```markdown
---
name: Feature request
about: Sugerir melhoria
labels: enhancement
---

**Problema**
<!-- Que problema isso resolve? -->

**Solução proposta**

**Alternativas consideradas**
```

- [ ] **Step 5: Commit**

```bash
git add .github/
git commit -m "chore: add dependabot, codeowners, PR/issue templates"
```

---

### Task 9: Atualizar README com seção de Development

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Adicionar seção após "Stack" ou no fim**

```markdown
## Development

### Setup

```bash
nvm use            # Node 20+
npm ci             # Install deps (instala husky automaticamente via prepare)
cp .env.example .env
```

### Scripts

| Script | Descrição |
|--------|-----------|
| `npm run dev` | Hot reload (tsx watch) |
| `npm run build` | Compila para `dist/` |
| `npm run start` | Roda `dist/index.js` |
| `npm run test` | Vitest |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint auto-fix |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check |
| `npm run typecheck` | tsc --noEmit |

### Commits

Conventional Commits obrigatório (validado por commitlint via husky):
- `feat:` — nova feature
- `fix:` — bug fix
- `chore:` — manutenção
- `docs:`, `test:`, `refactor:`, `perf:`, `ci:`, `build:`

### CI

Workflows em `.github/workflows/`:
- `ci.yml` — lint, typecheck, test, build
- `security.yml` — OSV scanner + npm audit
- `codeql.yml` — análise estática
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add development section to README"
```

---

### Task 10: Validação final e PR

- [ ] **Step 1: Verificar que tudo funciona localmente**

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
npm run build
```
Expected: tudo verde.

- [ ] **Step 2: Push e abrir PR**

```bash
git push origin HEAD:phase-1-ci-foundations
gh pr create --title "Phase 1: CI/CD Foundations" --body "$(cat docs/superpowers/plans/2026-05-14-phase-1-ci-cd-foundations.md | head -30)"
```

- [ ] **Step 3: Aguardar CI e verificar todos os jobs verdes**

```bash
gh pr checks --watch
```

- [ ] **Step 4: Merge após review**

---

## Definition of Done

- ✅ `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build` todos passam local
- ✅ 3 workflows GitHub Actions verdes em PR (ci, security, codeql)
- ✅ Husky bloqueia commit ruim (testado manualmente)
- ✅ Dependabot abre PRs semanais
- ✅ README documenta scripts e convenção de commits

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| ESLint type-aware muito lento em CI | Cachear `node_modules` + `.tsbuildinfo` via `actions/cache` |
| Lint encontra erros existentes | Corrigir no-floating-promises / no-misused-promises (bugs reais). Outros warnings ficam para PR seguinte |
| Husky não roda no Windows sem ajustes | Documentar `git config core.hooksPath .husky` se necessário; Husky 9 lida com isso |
| OSV Scanner falha em vuln existente | Aceitar como primeiro alerta; criar issue de seguimento |
