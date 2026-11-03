# Tools/Skills Canonical Unification — Design

> **Spec ID:** `2026-06-02-tools-skills-canonical-unification-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Opus 4.7) com instruções do founder em 2026-06-02
> **Escopo:** bernardTavares/bevox-harness#46 (audit SKILLS-05, severity: critical, debt)
> **Estimate:** 16h total across 4 phases
> **Issue:** bernardTavares/bevox-harness#46

## §1. Context

A auditoria 2026-06-02 (`runtime-gap-audit-2026-06-02.md:223`) identificou uma **dualismo crítico no modelo de ferramentas do harness**: a PRD §5.6 declara **skills (manifestos declarativos)** como o modelo canônico, mas o runtime (`execution-handler.ts`, reasoning engines, permission evaluator) consome exclusivamente o **ToolRegistry legado (plano, sem abstração de manifest)**. 

Hoje:

- **SkillRegistry** (`src/skills/skill-registry.ts:13-52`) foi introduzido na fase de bootstrap (estágio 5) e armazena `Map<name, LoadedSkill>`, onde cada skill possui `manifest.yaml` (name, description, category, agentType, parameters) + `index.ts` (função execute).
- **ToolRegistry** (`src/tools/registry.ts:3-63`) é o sistema legado: armazena `Map<name, ToolDefinition>` com metadados inline em cada ferramenta, sem abstração de manifest. Todas as call sites de runtime (execution-handler.ts:253, execution-handler.ts:896, reasoning/react.ts, permissions/evaluator.ts) resolvem ferramentas **exclusivamente via ToolRegistry**.

A **coexistência via adapter de backward-compat** (`skillToToolDefinition` em `src/skills/skill-registry.ts:54-63`) foi concebida como **transitória** (comentário em `src/skills/skill-registry.ts:8`: "Phase 8 transition"; `src/skills-builtin/README.md:9-13`: "will be removed in a follow-up PR"). O bootstrap stage 5 (`src/bootstrap/stages.ts:359-370`) ainda:

1. Carrega skills via SkillRegistry ✓
2. Registra todas as ferramentas LEGADAS via `registerAllTools(toolRegistry)` ✓
3. Espelha skills não cobertas como ToolDefinition adaptadas ✓

**Problema de manutenibilidade:** Sempre que um tool é adicionado/removido, o mantenedor deve:

- Criar a skill (`src/skills-builtin/<cat>/<name>/{manifest.yaml,index.ts}`)
- **E** criar/registrar a ToolDefinition legada em `src/tools/<cat>/<name>.tool.ts`
- Manter paridade entre as duas ou enfrentar breakage silencioso

Isso cria **confusão sobre a fonte de verdade**, divergência de risco em adições futuras, e acumula debt técnico. Nenhum consumidor (reasoning, permissions, execution-handler, MCP audit) tira proveito da **estrutura de manifest** porque tudo passa por ToolRegistry.

## §2. Problem statement

**Gap específico:** O SkillRegistry é o modelo canônico segundo a PRD, mas é um **passageiro** a bordo do ToolRegistry legado. O código de runtime não pode evoluir para consumir abstrações de manifest (e.g., agentType, category como tipos nativos em vez de strings) sem refatorar simultaneamente o ToolRegistry.

**Evidência:** 
- `src/bootstrap/stages.ts:365-370`: adaptação manual de LoadedSkill → ToolDefinition (conversor unidirecional, sem sincronização 2-way)
- `src/reasoning/react.ts:73-74`: recebe `tools: ToolDefinition[]` (sem manifest, sem agentType type-safe)
- `src/permissions/evaluator.ts:38-47`: filtra contra `ToolDefinition[]` (category é string, não enum tipado)
- `src/runtime/execution-handler.ts:253, 896`: `ToolRegistry.getInstance()` duplo (uma no cabeçalho, uma no resolvedor de workflow)
- `src/runtime/sdr-profile.ts` (inferred from stage 5 usage): usa `toolRegistry.all()` sem acesso a metadados de manifest

**Impacto mensurável:** 

- **Risco de divergência:** Tool adicionado apenas em skill-registry → invisível a reasoning engine (nenhum erro até runtime)
- **Debt na escalada de feature:** Qualquer feature que precisar de manifest metadata (e.g., tagging de ferramentas, agentType como union type) exigirá refatoração de ToolRegistry primeiro
- **Duplicação de lógica:** SkillLoader + SkillRegistry + adapter vs. registerAllTools + ToolRegistry = 2 stacks paralelos
- **Auditoria:** MCP execution audit assume ToolRegistry como source-of-truth; skills adicionadas via external SKILLS_PATH podem ou não estar sincronizadas dependendo do path de bootstrap

## §3. Goals & non-goals

**Goals:**

- Promover **SkillRegistry como canonical** e única fonte de verdade para tool/skill resolution em runtime (reasoning, permissions, execution-handler, MCP audit)
- Eliminar a necessidade de manter dois arquivos (skill manifest + legacy tool.ts) para cada ferramenta
- Simplificar bootstrap stage 5: carregar skills **uma única vez**, nenhuma registration dupla de ToolRegistry
- Permitir que code evolution no futuro (e.g., type-safe agentType, manifest tagging) funcione sem refatoração imediata de registries duplos
- Preservar interface de backward-compat para consumidores transitórios via adapter methods (e.g., `getAllTools(): ToolDefinition[]`)

**Non-goals:**

- Não estamos criando um "novo tipo de tool" ou "super-ferramenta" — simplemente unificando para um único source-of-truth
- Não estamos adicionando features de skill (e.g., versioning, hot-reload) — foco é consolidação estrutural
- Não estamos alterando comportamento de execution ou permissions logic — somente o plumbing de resolução
- Não é escopo refatorar consumidores em branches/PRs subsequentes (Phase 2 cubr isso)

## §4. Architecture proposal

### Decisão central

**Renomear SkillRegistry para ToolRegistry e estender para role de registro canônico:**

1. Mover `src/skills/skill-registry.ts` → `src/tools/unified-registry.ts` (novo arquivo que subscreve ambas as responsabilidades)
2. **Deletar `src/tools/registry.ts`** (o velho ToolRegistry legado)
3. **Estender** o unified registry para manter:
   - `Map<name, LoadedSkill>` (source of truth com manifest)
   - Métodos de query para retro-compat: `resolve(name): Tool | undefined`, `getAllTools(): ToolDefinition[]`, etc.

### Structure da unified registry (`src/tools/unified-registry.ts`)

```typescript
/**
 * Unified registry for tools/skills — canonical source of truth.
 * Armazena LoadedSkill (manifest + module); expõe ToolDefinition para
 * consumidores legados via adapter methods.
 *
 * O manifest é sempre presente e normativo. O ToolDefinition é derivado.
 */
export class UnifiedToolRegistry {
  private static instance: UnifiedToolRegistry;
  private tools = new Map<string, LoadedSkill>();
  private unavailable = new Set<string>();

  // Constructor (private per singleton pattern)

  static getInstance(): UnifiedToolRegistry { ... }
  static resetForTests(): void { ... }

  /** Registro primário: LoadedSkill (com manifest). */
  register(skill: LoadedSkill): void
  get(name: string): LoadedSkill | undefined
  has(name: string): boolean
  list(): LoadedSkill[]

  /** Query methods (backward-compat, derived from LoadedSkill). */
  resolve(name: string): ToolDefinition | undefined     // asToolDefinition(get(name))
  resolveOrThrow(name: string): ToolDefinition
  getAllTools(): ToolDefinition[]                        // list().map(asToolDefinition)
  listByCategory(cat: ToolCategory): ToolDefinition[]    // filter + map
  listByAgentType(type: ToolAgentType): ToolDefinition[] // NEW: filter manifests

  /** Availability tracking (kept from old ToolRegistry). */
  markUnavailable(name: string): void
  isAvailable(name: string): boolean
  getUnavailableNames(): string[]

  /** Adapter: LoadedSkill → ToolDefinition. */
  private asToolDefinition(skill: LoadedSkill): ToolDefinition { ... }
}

// Backward-compat export no src/tools/index.ts:
export { UnifiedToolRegistry as ToolRegistry }
```

### Bootstrap stage 5 — simplificado

Antes (atual, linhas 320–390):

```typescript
// 1) Load skills → SkillRegistry
// 2) Load external skills (optional) → SkillRegistry
// 3) registerAllTools(toolRegistry)  // Legacy tools
// 4) For each skill: if not in ToolRegistry, adapt + register
// 5) Validate tool references
```

Depois (com unified registry):

```typescript
const unifiedReg = UnifiedToolRegistry.getInstance();
const env = getEnv();

// 1) Load builtin skills
const loader = new SkillLoader({ disabled: ... });
const builtinSkills = await loader.loadFromPath(builtinRoot);
for (const skill of builtinSkills) {
  unifiedReg.register(skill);
}

// 2) Load external skills (optional)
if (env.SKILLS_PATH && ...) {
  const external = await loader.loadFromPath(env.SKILLS_PATH);
  for (const skill of external) {
    unifiedReg.register(skill);
  }
}

// 3) Validate all required tools exist (against unified registry)
const agentRegistry = AgentRegistry.getInstance();
for (const agent of agentRegistry.listByType("surface|pipeline")) {
  for (const toolName of agent.definition.permissions.required) {
    if (toolName !== "*" && !unifiedReg.has(toolName)) {
      throw new Error(`Required tool "${toolName}" not registered`);
    }
  }
}

// 4) (MCP clients loaded in separate stage — they register skills too)
```

**Nenhuma chamada dupla de registerAllTools. Nenhuma adaptação manual.**

### Migração de consumidores (resumo arquitetural)

Todos os call sites que usam `ToolRegistry.getInstance()` serão atualizados para `UnifiedToolRegistry.getInstance()`:

- `src/runtime/execution-handler.ts:253, 896` → resolve tool, chama execute() via `ToolDefinition`
- `src/reasoning/react.ts`, `plan-execute.ts`, `rewoo.ts` → resolvem tool names
- `src/permissions/evaluator.ts` → filtra contra manifest metadata
- `src/runtime/sdr-profile.ts` → lista ferramentas disponíveis
- `src/security/audit.ts` → audit MCP tools resolvendo do unified registry

**Nenhuma mudança de assinatura ou behavior** — é um "rename" estrutural de classe, não uma refactorização de business logic.

## §5. Implementation plan

### Phase 1 — Foundation: Unified registry + bootstrap cleanup (2–3h)

**Objetivo:** Mover SkillRegistry, estender com métodos de backward-compat, simplificar stage 5.

**Files a tocar:**

- `src/tools/unified-registry.ts` (NEW: merge de logic de skill-registry.ts + registry.ts)
- `src/tools/index.ts` — remover `registerAllTools()`, exportar UnifiedToolRegistry
- `src/bootstrap/stages.ts:320–390` — reescrever stage 5 para não chamar registerAllTools
- `src/skills/skill-registry.ts` — DELETE (substituída por unified-registry.ts)
- `src/tools/registry.ts` — DELETE (substituída por unified-registry.ts)

**Tests:**

- `tests/unit/tools/unified-registry.test.ts` (NEW) — resolve, list, filter, adapter, availability
- `tests/unit/bootstrap/stages.test.ts` (NEW) — stage 5 loads skills, validates required tools

**Completude:** Nenhum consumidor atualizado ainda — isso é Phase 2.

---

### Phase 2 — Migrate consumers: execution-handler, reasoning, permissions (6–8h)

**Objetivo:** Atualizar todos os call sites para usar UnifiedToolRegistry, preservar behavior.

**Files a tocar:**

- `src/runtime/execution-handler.ts` — Replace `ToolRegistry.getInstance()` → `UnifiedToolRegistry.getInstance()` (2 sites)
- `src/reasoning/react.ts`, `plan-execute.ts`, `rewoo.ts` — Update tool resolution (use adapter if needed, likely no changes pois chamam `execute(params)` já)
- `src/permissions/evaluator.ts` — Pode agora acessar `LoadedSkill.manifest` se quiser type-safe category/agentType (optional refine)
- `src/runtime/sdr-profile.ts` — Atualizar chamada a `toolRegistry.all()`
- `src/security/audit.ts` — Wire unified registry para MCP execution audit
- `src/mcp/execution-context.ts` — Remove/consolidate legacy ToolRegistry refs

**Tests:**

- `tests/unit/runtime/execution-handler.test.ts` — spot-check tool resolution 2–3 sites
- `tests/unit/reasoning/*.test.ts` — reasoning engines resolve tools correctly
- `tests/unit/permissions/evaluator.test.ts` — filtering works com novo registry
- `tests/integration/tools/*.test.ts` — existing tool tests pass (call e2e)

**Regression:** Run full test suite após cada subsistema para evitar surpresas.

---

### Phase 3 — Cleanup: remover legacy tool files (2–3h)

**Objetivo:** Deletar tudo que era específico do ToolRegistry legado.

**Files a deletar:**

- `src/tools/<category>/<name>.tool.ts` — todos os 13 (calendar/messaging/memory/knowledge tools)
  - calendar: read-calendar, list-appointments, create-appointment, cancel-appointment, reschedule-appointment, waitlist-add
  - messaging: send-message, request-human
  - memory: read-profile, write-profile, write-fact
  - knowledge: search-faq
- `src/tools/<category>/` — diretórios vazios após deletar .tool.ts files (se não houver outros arquivos)

**Referências a atualizações:**

- `src/tools/index.ts:1-18` — deletar todos os imports de tool.ts files
- `src/tools/index.ts:48-61` — deletar re-exports de ferramentas legadas

**Verificação:** grep para `\.tool\.ts\|registerAllTools\|ToolRegistry ` para confirmar cobertura.

---

### Phase 4 — Documentation & E2E validation (4–5h)

**Tests:**

- `tests/unit/tools/unified-registry.test.ts` — parity checks: resolve, list, filter
- `tests/integration/bootstrap/full-bootstrap.test.ts` (NEW) — stage 5 loads skills, all expected tools present, resolvable
- `tests/e2e/runtime-execution.test.ts` — dispatch a job end-to-end: execution-handler resolves skill, executes, success
- `tests/e2e/permissions.test.ts` — permission evaluator filters tools correctly from unified registry

**Documentation:**

- `CLAUDE.md:180–220` — remover "Phase 8 transition" language; document unified model como estado final
- `.claude/rules/harness-tools.md` — clarify: "tools **são** skills (manifest-based); ToolRegistry é agora UnifiedToolRegistry"
- `.claude/rules/harness-payload.md` — confirm `execution_payload.skills` resolve via unified registry; remover obsolete field refs
- `src/tools/unified-registry.ts` — JSDoc completo: explain unified model, adapter methods, bootstrap integration
- `src/skills-builtin/README.md:9-13` — remover "Phase 8 transition" language ("re-exports legacy tool")

**Verificação final:**

- `npm run test` — todos os testes passam
- `npm run lint` — sem warnings de referências órfãs
- `npm run build` — sem erros de tipo
- `npm run dev` — bootstrap completa, `/dev` endpoint lista tools (todos derivados de skills)

## §6. Testing strategy

**Unit-level (Phase 1):**

1. **UnifiedToolRegistry::resolve()** — resolve a skill by name, returns ToolDefinition with execute() callable
2. **UnifiedToolRegistry::list()** — returns all LoadedSkill[] (unordered)
3. **UnifiedToolRegistry::getAllTools()** — returns ToolDefinition[] (adapter), matches list() count
4. **UnifiedToolRegistry::listByCategory()** — filter works for calendar, messaging, etc.
5. **UnifiedToolRegistry::listByAgentType()** — (NEW) filter works for pipeline, surface, both
6. **UnifiedToolRegistry::markUnavailable()** / isAvailable() — tracking persists
7. **Bootstrap stage 5** — loads builtin + external (if SKILLS_PATH), validates required tools, no exceptions for valid configs

**Integration-level (Phase 2–3):**

1. **Execution-handler tool resolution** — dispatch a job, execution-handler.handleExecution() → resolveToolByName() → ToolDefinition.execute() → success
2. **ReAct loop** — reasoning/react.ts receives tools from unified registry, executes calendar/messaging tools, observes results
3. **Permissions filter** — evaluator filters tools via unified registry against agent.definition.permissions, respects pipeline/surface constraints
4. **MCP audit** — execution-handler wires MCP execution audit, records tool executions with unified registry lookups (no "tool not found" vs. "skill not found" mismatch)
5. **External skills** — SKILLS_PATH loads external skill, registered in unified registry, accessible to reasoning engines

**E2E validation (Phase 4):**

1. Bootstrap completa cleanly
2. `npm run dev` — `/dev` endpoint (if present) lists tools, all are derived from skills
3. Job dispatch (mock job in BullMQ) → harness consumes, executes skill, produces callback
4. Permissions audit logs tool executions, no errors

**Test files to create/update:**

- `tests/unit/tools/unified-registry.test.ts` (NEW)
- `tests/unit/bootstrap/stages.test.ts` (NEW) — stage 5
- `tests/unit/runtime/execution-handler.test.ts` — spot-check 2–3 tool resolution sites
- `tests/unit/reasoning/react.test.ts` — tool list ingestion
- `tests/unit/permissions/evaluator.test.ts` — filter against unified registry
- `tests/integration/tools/memory-tools.test.ts` (update if needed)
- `tests/integration/bootstrap/full-bootstrap.test.ts` (NEW)
- `tests/e2e/job-dispatch.test.ts` (if not exists; update if exists)

## §7. Migration & rollback

**Gradual activation:**

1. Phase 1 lands → UnifiedToolRegistry exists, SkillRegistry + old ToolRegistry still exist (parallel), no default switch yet
2. Phase 2 lands per subsystem (execution-handler → reasoning → permissions → audit) → each merged independently once tested
3. Phase 3 lands → Legacy .tool.ts files deleted, old ToolRegistry deleted (point of no return)
4. Phase 4 lands → Docs updated, full regression test suite passes

**Feature flag:** Não necessário (refactorização estrutural, não feature toggle).

**Rollback:**

- **Before Phase 1 merge:** SkillRegistry + old ToolRegistry coexist; new code unused
- **After Phase 1, before Phase 2 merge:** UnifiedToolRegistry in place, but consumers still use old ToolRegistry; can revert Phase 1 changes
- **After Phase 2 partial merge (e.g., only execution-handler migrated):** Other subsystems still use old ToolRegistry; partial rollback possible per subsystem
- **After Phase 3 merge:** Legacy files deleted; rollback requires restoring files from git history + reverting Phase 2 consumer changes
- **After Phase 4 merge:** Full consolidation locked in; docs reflect new state

**Validation before each phase merge:**

- Run full test suite
- grep for remaining references to old ToolRegistry / SkillRegistry (if supposed to be deleted)
- Manual spot-check of bootstrap stage 5 completion in local dev

## §8. Risks & open questions

**Technical risks:**

1. **MCP skill registration during bootstrap** — loadMcpClientsStage() (`src/bootstrap/stages.ts:120-178`) atualmente toca ambas SkillRegistry + ToolRegistry (linhas 148–150). Precisa ser atualizado para usar UnifiedToolRegistry. **Mitigação:** Inclua MCP in Phase 1 refactoring de stage 5.

2. **Backward-compat exports** — Alguns consumidores podem importar `ToolRegistry` por nome. Precisamos exportá-lo como alias (TypeScript `export { UnifiedToolRegistry as ToolRegistry }`) em `src/tools/index.ts` para evitar breakage de import. **Mitigação:** Adicione alias, grep para imports de "ToolRegistry" antes da merge Phase 3.

3. **Test mocks/stubs** — Testes existentes podem ter stubs de ToolRegistry. Phase 1 deve incluir atualização de todos os test mocks para usar UnifiedToolRegistry ou resetForTests(). **Mitigação:** Grep para `new ToolRegistry()` em files de teste; atualizar durante Phase 1.

4. **Singleton state leak entre testes** — UnifiedToolRegistry é singleton. Tests devem chamar resetForTests() no setup/teardown. **Mitigação:** Fixture comum em base test suite.

**Scope risks:**

1. **Mais call sites que estimado** — Se houver consumidores adicionais não documentados (e.g., em MCP context, agents registry, workflow engine), Phase 2 pode levar mais tempo. **Mitigação:** Grep exhaustivo em Phase 1 para todos os `.getInstance()` calls em ToolRegistry.

2. **Integration between SkillRegistry + AgentRouter + LLMGateway** — execution-handler é denso; possível que mudanças em call site primary afete fluxo de dados. **Mitigação:** Spot-check execution-handler.handleExecution() end-to-end em local dev após Phase 2.

**Open questions:**

1. **Devemos refatorar `listByAgentType()`?** Atualmente nenhum consumidor filtra por agentType em runtime. Incluir na unified registry? **Recomendação:** Sim, adicione como método; custa pouco e prepara terrain para features futuras (e.g., agent-scoped tool restrictions).

2. **Devemos consolidar `parameters` schema?** Skills e legacy tools ambos carregam `parameters: Record<string, unknown>`. Devemos usar JSON Schema tipado? **Recomendação:** Fora de escopo para esta spec; considerado em DEBT-03 follow-up.

3. **Qual é a estrutura final de `src/tools/`?** Após deletar todos os .tool.ts, resta apenas registry.ts + types.ts + index.ts. Reorganizar? **Recomendação:** Deixe como está por enquanto; index.ts exporta UnifiedToolRegistry + tipos. Em future refactor, considere mover para `src/registry/` se crescer.

## §9. Definition of done

- [ ] Phase 1 merged
  - [ ] UnifiedToolRegistry class em `src/tools/unified-registry.ts` com todos os métodos (resolve, list, filter, adapter, availability)
  - [ ] `src/skills/skill-registry.ts` DELETED (conteúdo movido para unified-registry.ts)
  - [ ] `src/tools/registry.ts` DELETED (substituído por unified-registry.ts)
  - [ ] `src/bootstrap/stages.ts` stage 5 reescrito: carrega skills, nenhuma chamada registerAllTools()
  - [ ] `tests/unit/tools/unified-registry.test.ts` com cobertura 100% (resolve, list, filter, adapter, availability)
  - [ ] `tests/unit/bootstrap/stages.test.ts` valida que stage 5 carrega skills + validates required tools
  - [ ] `npm run test` passa para all unit + bootstrap tests
  - [ ] grep confirm: nenhuma reference remaining a `new SkillRegistry()` no código (à exceção de resetForTests mocks)

- [ ] Phase 2 merged
  - [ ] `src/runtime/execution-handler.ts` — todas as chamadas ToolRegistry.getInstance() → UnifiedToolRegistry.getInstance() (verificar 2+ sites)
  - [ ] `src/reasoning/{react,plan-execute,rewoo}.ts` — tool resolution atualizada, tests pass
  - [ ] `src/permissions/evaluator.ts` — wired para unified registry, tests pass
  - [ ] `src/runtime/sdr-profile.ts` — atualizado se necessário
  - [ ] `src/security/audit.ts` — MCP execution audit usa unified registry
  - [ ] `src/mcp/execution-context.ts` — cleaned up se necessário
  - [ ] `tests/unit/runtime/execution-handler.test.ts` — spot-check 2+ call sites resolvem tools
  - [ ] `tests/unit/reasoning/*.test.ts` — reasoning engines pass
  - [ ] `tests/unit/permissions/evaluator.test.ts` — filtering works
  - [ ] `npm run test` passa para all tests (regressions checked)

- [ ] Phase 3 merged
  - [ ] Todos os `src/tools/<category>/<name>.tool.ts` files DELETED (13 tools)
  - [ ] `src/tools/<category>/` diretórios removidos se vazios
  - [ ] `src/tools/index.ts` limpo: nenhum import de .tool.ts files, nenhum registerAllTools(), UnifiedToolRegistry exportado
  - [ ] grep confirm: nenhuma remaining reference a deleted .tool.ts files

- [ ] Phase 4 merged (docs + final validation)
  - [ ] `CLAUDE.md` — "Phase 8 transition" language removed; unified model documented
  - [ ] `.claude/rules/harness-tools.md` — clarifies tools são skills
  - [ ] `.claude/rules/harness-payload.md` — confirms skills resolve via unified registry
  - [ ] `src/tools/unified-registry.ts` JSDoc — complete, explains unified model + adapter
  - [ ] `src/skills-builtin/README.md` — "Phase 8 transition" removed
  - [ ] `tests/integration/bootstrap/full-bootstrap.test.ts` — stage 5 loads all expected skills, all resolvable
  - [ ] `tests/e2e/job-dispatch.test.ts` — end-to-end job execution passes
  - [ ] `npm run lint` — no warnings
  - [ ] `npm run build` — no type errors
  - [ ] `npm run test` — all tests pass, no regressions
  - [ ] Code review approved

- [ ] Audit finding SKILLS-05 closed
  - [ ] PR references audit doc
  - [ ] Comment on audit doc linking to merged PR

## §10. References

- **Audit:** `runtime-gap-audit-2026-06-02.md:223` (SKILLS-05 finding)
- **Issue:** bernardTavares/bevox-harness#46
- **Related findings:** SKILLS-04 (false claim in docs), SKILLS-06 (incomplete tool doc), DEBT-03 (two concurrent schemas)
- **Related ADRs:** None (this is structural consolidation, not a decision point)
- **Code references:**
  - `src/skills/skill-registry.ts:13-52` — SkillRegistry current (to be deleted)
  - `src/tools/registry.ts:3-63` — old ToolRegistry (to be deleted)
  - `src/bootstrap/stages.ts:320-390` — stage 5 (to be rewritten)
  - `src/runtime/execution-handler.ts:253, 896` — ToolRegistry.getInstance() call sites
  - `src/tools/index.ts:26-46` — registerAllTools() (to be deleted)
  - `src/skills-builtin/README.md:9-13` — Phase 8 transition note (to be removed)
- **Prior specs:** 2026-05-28-go-live-via-hetzner-mcp.md (context: harness in production, tool consolidation needed for maintainability)
