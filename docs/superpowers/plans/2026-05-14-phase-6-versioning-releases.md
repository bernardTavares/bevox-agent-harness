# Phase 6: Versioning & Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Estabelecer versionamento semântico com CHANGELOG automatizado e workflow de release, espelhando a prática do Hermes (releases v0.2.0 → v0.13.0 documentadas).

**Architecture:** `changesets` para gerenciar versões e changelog (mais leve que release-please, ideal para mono-pacote TypeScript). Conventional commits validados pela Fase 1 (commitlint). Workflow `release.yml` que: (1) abre PR com bump de versão + CHANGELOG quando há changesets na main, (2) cria tag + GitHub Release no merge.

**⚠ Não publica no npm.** Marcado como `"private": true` em `package.json` — esse é o mecanismo correto. `access: "restricted"` apenas controla visibilidade quando publicação acontece; não previne publish. O `changesets/action` cria GitHub Release nativamente quando o pacote é privado.

**Tech Stack:** @changesets/cli, @changesets/changelog-github, GitHub Actions, GitHub Releases.

---

## Dependencies

- **Hard:** Fase 1 (CI + commitlint + Husky já configurados).
- **Soft:** Nenhuma.
- **Blocks:** Nada.

## Files Touched

### Create
- `.changeset/config.json`
- `.changeset/README.md`
- `.github/workflows/release.yml`
- `CHANGELOG.md`
- `docs/CONTRIBUTING.md` (seção de release)

### Modify
- `package.json` (scripts: `changeset`, `version-packages`, `release`; version baseline)
- `README.md` (badge de versão)

### High-conflict files
- ⚠️ `package.json` — Fases 1, 2, 4, 5
- ⚠️ `.github/workflows/` — Fase 1

## Estimated Effort
2-3 dias (~12 horas).

---

## Tasks

### Task 1: Instalar e inicializar changesets

**Files:**
- Create: `.changeset/config.json`, `.changeset/README.md`
- Modify: `package.json`

- [ ] **Step 1: Instalar**

```bash
npm install --save-dev @changesets/cli @changesets/changelog-github
```

- [ ] **Step 2: Inicializar**

```bash
npx changeset init
```

- [ ] **Step 3: Garantir `"private": true` em `package.json`**

```json
{
  "name": "bevox-agent-harness",
  "private": true,
  "version": "0.1.0",
  ...
}
```

**Crítico:** `private: true` é o que efetivamente impede `changeset publish` de tentar fazer upload pro npm registry. Sem isso, o workflow falha (sem `NPM_TOKEN`) ou tenta publicar.

- [ ] **Step 4: Editar `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": [
    "@changesets/changelog-github",
    { "repo": "bernardTavares/bevox-agent-harness" }
  ],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

Ajustar `repo` conforme owner/name reais.

- [ ] **Step 5: Adicionar scripts**

```json
"changeset": "changeset",
"version-packages": "changeset version",
"release": "changeset tag"
```

(`changeset tag` em vez de `changeset publish` — apenas cria git tags, não tenta npm publish. Com `private: true`, ambos seriam no-op no npm, mas `tag` é semanticamente mais correto.)

- [ ] **Step 6: Commit**

```bash
git add .changeset/ package.json package-lock.json
git commit -m "build: initialize changesets for versioning"
```

---

### Task 2: Criar CHANGELOG inicial

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: `CHANGELOG.md` — apenas baseline histórico**

⚠ Não incluir seção `[Unreleased]` — changesets gerencia o arquivo daqui em diante. Listar apenas `[0.1.0]` como anchor histórico para readers.

```markdown
# Changelog

All notable changes to Bevox Agent Harness are documented in this file.
This file is auto-managed by [changesets](https://github.com/changesets/changesets) from v0.1.1 onward.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-14

### Added
- Initial Bevox Agent Harness MVP
- 5 reasoning engines (Direct, ReAct, Plan&Execute, ReWOO, Reflexion)
- 13 tools (calendar, messaging, memory, knowledge)
- 7-stage bootstrap, 10-step execution flow
- BullMQ consumer + Bevox HTTP callbacks
- PostgreSQL memory (contact_profiles, contact_facts)
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add CHANGELOG.md baseline at v0.1.0"
```

---

### Task 3: Workflow de Release

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: `release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - run: npm ci

      # Não duplicar CI aqui — confiar no gate de merge do ci.yml (Fase 1).

      - name: Create Release Pull Request or Tag
        id: changesets
        uses: changesets/action@v1
        with:
          version: npm run version-packages
          publish: npm run release
          title: "chore: release"
          commit: "chore: version packages"
          createGithubReleases: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Notas:**
- `changesets/action@v1` cria GitHub Releases nativamente quando `createGithubReleases: true` e há tags novas. Não precisa de step manual com `gh release create`.
- Como `package.json` tem `"private": true`, `npm run release` (`changeset tag`) só cria tags Git — não tenta npm publish.
- Conteúdo do release é extraído pelo action da seção correspondente de `CHANGELOG.md`, não dumpa o arquivo inteiro.

- [ ] **Step 2: Commit**

```bash
git commit -m "ci: add release workflow with changesets"
```

---

### Task 4: Documentar fluxo de release em CONTRIBUTING

**Files:**
- Create: `docs/CONTRIBUTING.md` (ou modificar existente)

- [ ] **Step 1: Seção "Releases"**

```markdown
## Releases

Usamos [Changesets](https://github.com/changesets/changesets) + SemVer.

### Como contribuir para um release

Ao abrir um PR com mudança visível para usuários da harness (feature, fix, breaking change):

```bash
npx changeset
```

Selecione:
- `patch` — bug fix / mudança interna
- `minor` — nova feature / capability
- `major` — breaking change na API/contrato (raro)

Escreva uma linha descrevendo a mudança. O arquivo `.changeset/*.md` gerado é commitado junto ao PR.

### Como release é publicado

1. PR com changesets é mergeado em `main`
2. Workflow `release.yml` abre um **Release PR** agregando todos os changesets pendentes
3. Esse Release PR tem CHANGELOG atualizado e bump de versão em `package.json`
4. Ao mergear o Release PR, o workflow:
   - Tag `vX.Y.Z` é criado
   - GitHub Release é publicado com notas

### Convenção

- `patch`: 0.1.0 → 0.1.1
- `minor`: 0.1.0 → 0.2.0
- `major`: 0.x.y → 1.0.0 (estabilização)
- Pré-1.0: mudanças em `minor` podem quebrar; documentar em "Breaking changes" do changelog
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: document release flow in CONTRIBUTING"
```

---

### Task 5: Atualizar README com badge de versão

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Adicionar badges no topo**

```markdown
[![CI](https://github.com/bernardTavares/bevox-agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/bernardTavares/bevox-agent-harness/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/bernardTavares/bevox-agent-harness)](https://github.com/bernardTavares/bevox-agent-harness/releases)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add status badges to README"
```

---

### Task 6: Smoke test — criar primeiro changeset e disparar release

- [ ] **Step 1: Criar changeset de exemplo**

```bash
npx changeset
# Selecionar patch, escrever "Initial release workflow validation"
```

- [ ] **Step 2: Commit + PR**

```bash
git add .changeset/
git commit -m "chore: validate release workflow"
git push
gh pr create --title "Phase 6: Versioning & Releases" --body "Setup changesets + release workflow"
```

- [ ] **Step 3: Após merge, verificar:**
- Release PR aparece automaticamente
- Mergear Release PR
- Tag `v0.1.1` criada
- GitHub Release publicado

---

## Definition of Done

- ✅ `npx changeset` funcional
- ✅ Workflow `release.yml` cria Release PR automaticamente quando há changesets
- ✅ Merge do Release PR cria tag e GitHub Release
- ✅ CHANGELOG mantido automaticamente
- ✅ Documentação de release em CONTRIBUTING
- ✅ Primeiro release pós-setup publicado com sucesso

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Changesets publicando no npm sem querer | `"private": true` em `package.json` (mecanismo real); `release` script usa `changeset tag` em vez de `publish`; verificar em smoke test |
| Workflow dispara em loop (release PR retriggando) | `concurrency` group + skip de bot commits |
| Devs esquecem de adicionar changeset | CI opcional `changeset-check`: bot comenta no PR se faltar (PR de seguimento) |
| Conflito em `package.json` com outras fases | Mergear Fase 1 e 2 primeiro; bumpar versão depois |
