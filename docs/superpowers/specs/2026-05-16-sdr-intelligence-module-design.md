# SDR Intelligence Module — Design

- **Data:** 2026-05-16
- **Status:** Design only (somente desenho — nenhuma implementação autorizada nesta fase)
- **Escopo desta spec:** Fase 0 e Fase A em profundidade implementável; Fases B e C em nível de design/arquitetura (contratos, decisões, riscos, dependências).
- **Origem:** destilação de dois livros de SDR — *Predictable Revenue* (Aaron Ross) e *The Sales Development Playbook* (Trish Bertuzzi) — em camadas cognitivas mapeadas nos pontos de extensão existentes do bevox-agent-harness.

---

## 1. Visão geral e princípios

### 1.1 O que é

O **SDR Intelligence Module** é um subsistema *bounded* dentro do bevox-agent-harness que adiciona uma "forma de pensar SDR" (prospecção, qualificação, cadência, handoff) como **modo de raciocínio transversal**, não como nicho vertical.

O harness atende múltiplos nichos simultâneos via surface agents de domínio (clínica: remarcação/agendamento/cancelamento/confirmação; cinema: sessões/promoções/estreias). Esses agentes **atendem quem chegou**. SDR é ortogonal: é a inteligência de **gerar engajamento proativo a partir de contatos frios/dormentes**. Mapeamento por nicho:

- Clínica → reativação de paciente inativo, recuperação de no-show, preenchimento proativo de cancelamento.
- Cinema → recuperação de membro dormente, promoção de estreia para base inativa.

É a mesma forma de pensar emprestada por qualquer vertical quando o objetivo é "ir atrás", não "atender quem veio". Por isso é uma faculdade cognitiva ("região cerebral"), não um agente de nicho.

### 1.2 Princípios invioláveis

1. **Juízo no lar certo por tipo.** Juízo *linguístico* (qualificar, contornar objeção, redigir mensagem) → doutrina + RAG governados por eval. Juízo *aritmético* (score PACT, segmentação ABCD) → código de skill determinístico. Juízo *procedural* (transição de estado legal) → FSM com guards determinísticos.
2. **Regra dos dois livros como regra de engenharia.** Onde Ross e Bertuzzi **concordam → constante hardcoded**. Onde **conflitam → parâmetro tunável** em `harness-config.ts` com hook de A/B; nunca escolha fixa. (Catálogo de conflitos na §7.)
3. **Divisão de trabalho dos livros.** Ross = arquitetura macro: especialização rígida de papéis, FSM Account Status, gate de re-qualificação pelo AE como única transição que credita sucesso. Bertuzzi = execução micro: cadências 7×7/9×15, mensagem letra-F, 4 regras de voicemail, rubrica PACT, métricas de 3 níveis.
4. **Anti-over-claim como artefato de primeira classe.** O "audit gate" do Ross — o agente nunca declara uma oportunidade qualificada sem evidência observada — vira asserção de eval automatizada, não comentário.
5. **Aditivo sobre o harness.** Povoar camadas existentes (RAG, manifesto de skills, context layers, workflow durável, evals). Reescrita de core só onde inevitável e isolada (vide Fase 0).

### 1.3 As 6 camadas cognitivas e seus lares

| Camada | Conteúdo | Lar no harness | Fase |
|---|---|---|---|
| **L0 Doutrina** | Postura, frases proibidas, fronteira dos *Five Whys*, regra de uma-pergunta-por-email | `BaseConfigLayer` (prio 10, não-compressível) via `agentConfig.systemPrompt` | 0 + A |
| **L1 Conhecimento** | ICP/personas 8-campos, rubrica PACT/PACT2, Seeds/Nets/Spears, ABCD, red-flags, biblioteca de exemplares | RAG (`src/rag`) + skill `search-faq`, account-scoped | A |
| **L5 Eval** | Certification gates (Prospect/Message-Ready, "qualificou-sem-evidência → falha") | `src/evals` (scorers + suite fixture-replay) | A |
| **L2 Skills** | `qualify_opportunity/PACT`, `segment_account/ABCD`, `enrich_3C` (só determinísticas) | `src/skills-builtin` manifesto | B |
| **L3 Contexto** | sales-state: IDs, status, último toque (pequeno) | Nova `ContextLayer` não-compressível | B |
| **L4 Processo** | FSM Account Status + cadência 7×7/9×15 + handoff + gate de re-qualificação | Workflow durável existente (`src/workflow`) + elo de correlação novo | C |
| **Tunáveis** | Catálogo de conflitos Ross×Bertuzzi | `src/config/harness-config.ts` + hook A/B | Transversal |

---

## 2. Acoplamento na execução

### 2.1 Os 10 passos do harness e onde o SDR entra

```
1 valida payload → 2 dedup → 3 session → 4 callback "running"
5 PIPELINE: MessageAnalyzer → MemoryExtractor
6 AgentRouter.resolve(intent) → surface agent
7 BUILD CONTEXT (5 camadas, token budget)   ←──┐
8 filtra permissões (expõe tools)            ←──┤  SDR acopla aqui (Fases A/B)
9 SURFACE AGENT LOOP (engine + tools)        ←──┘
10 callback "complete"
```

- **Passo 7 — ponto de acoplamento principal.** O context builder é a única costura que todo surface agent de todo nicho já consome. O SDR injeta aqui um grupo de camadas **condicionais** (L0 doutrina no slot protegido, gancho de L1, L3 sales-state). O agente de domínio (ex.: remarcação da clínica) continua sendo o mesmo agente; sua cognição é aumentada.
- **Passo 8 —** o filtro de permissões expõe as skills SDR determinísticas (Fase B) na lista de tools daquele agente.
- **Passo 9 —** o mesmo loop de sempre; o agente raciocina/age como SDR porque a cognição foi aumentada nos passos 7–8. Sem orquestração nova nas Fases A/B.
- **Passo 9 (Fase C, exceção) —** para contas cujo trabalho principal *é* prospecção ativa, o agente declara um `workflow` e a **precedência de workflow substitui o passo 9** (FSM Account Status + cadência). Referência: `src/runtime/execution-handler.ts:607-612`.
- **Passo 5 (modulador) —** o `MessageAnalyzer` emite o sub-modo SDR consumido no passo 7 (vide §2.3).
- **L5 Eval —** fora do hot path; replay offline de execuções via `src/evals`.

### 2.2 Gate determinístico — contrato `sdr_profile`

O payload do Bevox passa a poder conter `agent_config.sdr_profile`. Semântica de gate booleano:

- **Presente** → o context builder materializa as camadas SDR.
- **Ausente** → execução 100% normal, custo zero, nicho não-SDR não é afetado nem percebe o módulo.

Implicações de design:
- `sdr_profile` é o **contrato Bevox ↔ harness**. Precisa ser desenhado dentro do schema Zod de `agent_config` do payload, que vive em `src/runtime/execution-handler.ts` (~linha 100, `agent_config: z.record(...).refine(...)`) — **não** no bootstrap.
- O router **não muda**. Cada conta de cada nicho habilita SDR explicitamente via config.
- Falha segura: gate off = sem efeito colateral algum.

Conteúdo mínimo proposto para `sdr_profile` (a refinar na Fase A):
- `enabled: boolean`
- `icp_ref` / `persona_refs` — ponteiros para entradas de KB (L1) account-scoped
- `qualification_framework: "PACT" | "PACT2"` (tunável; default por maturidade de mercado)
- `cadence_ref` (só relevante na Fase C)

### 2.3 Modulador probabilístico — sub-modo do MessageAnalyzer

Quando o gate está ligado, o `MessageAnalyzer` (pipeline, já roda sempre) passa a emitir também um **sub-modo SDR**, p.ex.: `reativacao | qualificacao | nurture | handoff-iminente`.

- O sub-modo **não liga/desliga** o SDR — ele apenas seleciona *qual fatia* da doutrina/KB e *quais* skills a camada SDR injeta no passo 7.
- Juízo probabilístico fica contido: só refina dentro de um gate já determinístico; nunca decide sozinho se o SDR roda.
- Falha segura: sub-modo errado → doutrina SDR genérica em vez de específica; nunca SDR onde não devia.
- **Faseamento do consumo (resolve dependência):** o *cálculo* do sub-modo é saída nova do `MessageAnalyzer` (`src/agents/pipeline/message-analyzer.agent.ts`) e pode ser entregue já. Mas o *consumidor* que filtra doutrina/skills por sub-modo só existe quando a nova `ContextLayer` sales-state estiver disponível — **Fase B**. Portanto: na **Fase A a doutrina é gate-only e não-filtrada** (o `sdr_profile` materializa a doutrina SDR genérica completa); a **modulação por sub-modo é Fase B** (a `ContextLayer` consome o sub-modo e seleciona a fatia). Isso elimina a contradição com §3.2 (não editar engines) e §4.1.

---

## 3. Fase 0 — Provar o caminho da doutrina *(pré-requisito; bloqueia tudo)*

### 3.1 Problema (premissa verificada no código)

A doutrina **não desaparece — ela chega degradada**. Mecanismo verificado:

- `src/runtime/execution-handler.ts:725` monta `const input = \`${systemPrompt ? systemPrompt+"\n\n" : ""}User request:\n${userMessages}\``. O `BuiltContext.systemPrompt` é **concatenado dentro da string de input**, misturado com a mensagem do usuário.
- `src/reasoning/react.ts:58-63` (`plan()`) faz `goal: input` — ou seja, o input (com a doutrina embutida) vira o `plan.goal`.
- `src/reasoning/react.ts:85` (`buildSystemPrompt(plan.goal, toolsDescription)`) reconstrói o system prompt a partir de goal+tools; replicado em `direct.ts`, `plan-execute.ts`, `rewoo.ts`.

Consequência real: a doutrina L0 chega ao engine **apenas via concatenação no canal `goal`**, fundida com o request do usuário, **sem role `system` dedicado e sem garantia de fidelidade/separação** (sujeita a qualquer truncamento/diluição do caminho do goal). O risco não é "o agente nunca lê" — é "o agente lê doutrina misturada com o pedido do usuário, sem hierarquia de instrução". Para uma doutrina que precisa ter precedência sobre o pedido (fronteira dos Five Whys, frases proibidas, anti-over-claim), entrega no canal `goal` é insuficiente. **Nenhuma fase posterior é confiável sem isso resolvido.**

### 3.2 Decisão de design

A doutrina deve chegar ao engine como **mensagem de role `system` estruturada / canal dedicado**, não fundida no `goal`. Não editar `buildSystemPrompt()` em 4 engines (alto blast radius na zona minimal-change de `src/reasoning/`). Caminho correto: alterar o ponto único onde `runSurfaceAgentLoop` (função exportada em `src/runtime/execution-handler.ts:196`) entrega o `systemPrompt` ao engine — separá-lo do `input`/`goal` e passá-lo como system message de primeira classe. Correção num **único ponto de integração**.

### 3.3 Entregáveis (design)

- Análise documentada do fluxo verificado (`execution-handler.ts:725` → `react.ts:58-63 plan()` → `react.ts:85 buildSystemPrompt`).
- Decisão: ponto único onde o `systemPrompt` é separado do `goal` e entregue como system message ao passo de raciocínio (ReAct + demais engines por consistência).
- **Habilitar observabilidade do prompt:** o payload de trace atual (`src/reasoning/react.ts:136-141`) carrega só `engineStrategy/stepIndex/stepResult/observation` — **não** o system prompt resolvido. É entregável da Fase 0 estender o trace para expor o prompt efetivamente entregue ao engine (sem isso o critério de aceitação não é observável).
- Nenhum conhecimento SDR ainda. Zero migration. Blast radius: 1 ponto de integração + extensão de trace + 1 teste.

### 3.4 Critério de aceitação

Teste fixture-replay com texto-sentinela no `agentConfig.systemPrompt`, asserindo via trace estendido (§3.3) **duas** condições, não uma: (a) o sentinela chega ao passo de raciocínio; (b) chega no canal `system` **separado** da string do request do usuário (uma asserção que só passa se o sentinela NÃO estiver concatenado no `goal`). Critério desenhado assim de propósito: um teste de mera presença passaria trivialmente hoje (a doutrina já se concatena no goal) e não provaria o que a Fase 0 precisa provar. Verde nas duas condições = Fase 0 concluída e Fase A desbloqueada.

---

## 4. Fase A — Faculdade Cognitiva *(fundacional; risco baixo; detalhada)*

Três camadas que dão a qualquer surface agent existente a "forma de pensar SDR", sem agentes novos, sem workflow, sem estado multi-dia.

### 4.1 L0 — Doutrina

**Conteúdo (regras imperativas curtas, não prosa destilada):**
- Postura: "pesquisador não-ameaçador, não vendedor agressivo"; "a verdade é o marketing mais persuasivo" (Ross); "suspenda o ego / buyer-based, não seller-based" (Bertuzzi).
- Lista de **frases proibidas** como restrições negativas (Bertuzzi: "touch base", "see if there are synergies", "if you're not the right person…", preâmbulo "nome+empresa" em voicemail).
- **Fronteira dos Five Whys:** o agente NUNCA persegue *Why Change / Why You / Why Now* (domínio do AE/closer); escopo do SDR = *Why Listen* + *Why Care* apenas.
- Regra de **uma-pergunta-por-email** (Ross): cada mensagem fecha em exatamente UM próximo passo (referral XOR call), nunca ambos.
- Objetivo de função: otimizar para *menos e melhores* oportunidades, não volume ("AEs são o cliente do SDR").

**Lar e restrições:** `agentConfig.systemPrompt` → `BaseConfigLayer` (prio 10, **não-compressível**). Cada token de doutrina reduz permanentemente o budget de `history`/`memory` (que comprimem por truncamento de linha — `src/context/context-builder.ts:32-64`). Disciplina obrigatória: L0 = poucas centenas de tokens de regras imperativas, materializadas **condicionalmente** ao gate `sdr_profile`. **Na Fase A a doutrina é gate-only e não-filtrada** (doutrina SDR genérica completa); a filtragem por sub-modo do MessageAnalyzer é **Fase B** (vide §2.3) — não há consumidor de sub-modo na Fase A e §3.2 proíbe editar engines para isso.

### 4.2 L1 — Conhecimento (RAG)

**Conteúdo (ingerido na pipeline RAG existente, account-scoped):**
- ICP / personas no schema de 8 campos (Target Titles · High-Level Objective · Role & Responsibilities · Challenges & Obstacles · Success Metrics · Risks & Fears · Consequences of Status Quo · Big Win We Deliver).
- Rubrica **PACT** (Pain, Authority, Consequence, Target profile) e **PACT2** (+ Timing) — Bertuzzi rejeita BANT explicitamente.
- Taxonomia **Seeds/Nets/Spears** (Ross) e segmentação **ABCD** (Bertuzzi) — para o agente nunca misturar tipos de lead em previsão.
- Catálogo de **red-flags / Dead-End** e mapa objeção→causa-raiz.
- **Biblioteca rotulada** de e-mails/voicemails bons e ruins (exemplares, não templates compartilhados — Ross: template copiado perde voz e decai).

**Lar e custo:** `src/rag/retriever.ts`, `src/rag/vector-store.ts` (já account-scoped, OTEL-instrumentado). Recuperado sob demanda via caminho `search-faq`/KB. **Custa token só quando recuperado** — modelo de custo correto para exemplares. Adicionar KB é ingestão de dados, não código de core. Namespace por `source`. **Zero migration.**

### 4.3 L5 — Eval (certification gates)

**Conteúdo:** os *certification gates* de Bertuzzi reformulados como suite de eval fixture-replay:
- **Prospect-Ready:** dado um cenário, o agente articula ≥N de [personas/pains/trigger events/red-flags] (rubrica objetiva ≥N-de-lista).
- **Message-Ready:** dado lead-dummy, produz e-mail/voicemail customizado respeitando letra-F, 4 regras de voicemail e lista de frases proibidas.
- **Audit gate (keystone, anti-over-claim do Ross):** dado um transcript SEM sinal de autoridade/pain, asserta que o agente **NÃO** emitiu veredito "qualificado".

**Lar:** `src/evals` (`runner.ts`, `registry.ts`, `repository.ts`, scorers, judge-prompt). Certification gates = novos scorers + entrada no registry. Suite roda como replay de fixtures pelo engine real, asserindo sobre `traceCallback`/saída de `synthesize()`. Aditivo, fora do hot path.

### 4.4 Critério de aceitação da Fase A

Fase A concluída quando os três scorers de certification-gate (§4.3) estiverem registrados em `src/evals/registry.ts` e **verdes** em suite fixture-replay, executando pelo engine real com uma conta-sentinela com `sdr_profile.enabled = true`:
- **Prospect-Ready** verde: o agente articula ≥N de [personas/pains/triggers/red-flags] no cenário-fixture.
- **Message-Ready** verde: e-mail/voicemail gerado respeita letra-F, 4 regras de voicemail e a lista de frases proibidas.
- **Audit gate** verde (keystone): dado transcript sem sinal de autoridade/pain, o agente **não** emite veredito "qualificado".
- Regressão: conta **sem** `sdr_profile` produz saída idêntica ao baseline pré-Fase-A (prova de gate de custo-zero).

### 4.5 Entrega da Fase A

Zero migration, aditivo puro, valor imediato a qualquer surface agent já existente que tenha `sdr_profile`. É a única fase que põe juízo linguístico no lar onde um LLM o faz bem e a única onde a defesa anti-over-claim é artefato de primeira classe.

---

## 5. Fase B — Skills determinísticas *(design/arquitetura)*

### 5.1 Escopo

Promover a skill **somente as faculdades determinísticas** (aritméticas/classificatórias), onde código remove superfície de alucinação:
- `qualify_opportunity` / PACT — score com **evidência obrigatória** como input, não auto-relato. É a defesa anti-over-claim do Ross como *computação enforced*.
- `segment_account` / ABCD — classificação + filtro red-flag/Dead-End (gate de roteamento).
- `enrich_3C` — Company/Contact/ConversationStarter, ≤10min, cacheado.

**Explicitamente fora de B:** `compose_email` / `compose_voicemail` **não** viram skill. Redação é juízo linguístico e fica no loop governado pela doutrina (L0). Skill que chama LLM internamente criaria um 2º prompt sem governança que vaza as frases proibidas; skill template-fill seria robótica e contraria a tese "humano, relevante" dos livros.

### 5.2 Decisões que B força

1. **Colisão do enum `category`.** `src/skills/skill-manifest.schema.ts:48` enumera `category` em `calendar|messaging|memory|knowledge` e é `.strict()`. Não existe `sales`. `qualify_opportunity`/`segment_account`/`enrich_3C` não mapeiam honestamente em categoria existente. **Decisão recomendada:** adicionar `sales` ao enum deliberadamente, aceitando o ripple do `.strict()` e de qualquer switch exaustivo sobre category — em vez de abusar de `knowledge`/`memory`.
2. **Gap de permissões não-enforced.** `skill-manifest.schema.ts:51` — permissões são documentais em V1, não enforced. Skills SDR com side-effect (`external_call`, `stop_signal`) rodariam sem enforcement. **Decisão:** Security Engineer deve fechar ou aceitar formalmente esse gap **antes** de qualquer skill com efeito colateral. (Nas Fases A/B as skills propostas são read/compute — sem side-effect — mas o gap precisa de decisão antes de C.)

### 5.3 L3 — Contexto sales-state

Nova `ContextLayer` (template: `src/context/layers/memory.layer.ts`; registro em `src/context/layers/index.ts`). **Não-compressível e pequena** (IDs, status enum, último toque) — decisão crítica, não narrativa, não pode ser truncada por linha. 1 migration aditiva (`sdr_account_state` ou colunas em profile existente; mirror do padrão `contact_facts`).

### 5.4 Entrega da Fase B

1 migration. Entrega *leitura stateful de um registro plano de sales-state* — **não** cadência. Stakeholders devem entender que B não entrega processo multi-dia.

---

## 6. Fase C — Pipeline Ativo *(design/arquitetura; com gate)*

### 6.1 Escopo

A "máquina de vendas" do Ross executando: FSM Account Status (`Cold → Working → {Nurture:Active | Nurture:Quarterly | Nurture:Dead}` com estados absorventes `Avoid:*`), cadência multi-dia (7×7 SalesLoft ou 9×15 Bridge Group — tunável), handoff e **gate de re-qualificação pelo AE como única transição que credita sucesso**.

### 6.2 Descoberta-chave: o workflow durável já existe

`src/workflow/` é um engine durável: `state-store.ts` persiste em `workflow_executions` (JSONB versionado, `suspend_token`, `timeout_at`); `WorkflowSuspendError` + `SuspendSignal{resumeOn,timeoutMs}` dão suspensão multi-dia; `resume-server.ts` é webhook autenticado de resume; `listExpired()` + `WorkflowCleanupJob` reativam por timeout; `execution-handler.ts:607-612` dá precedência de workflow sobre reasoning. **O esqueleto da FSM/cadência não precisa ser construído.**

Mapeamento: Account Status FSM → `WorkflowDefinition` (`src/workflow/types.ts:86`); cadência → `ctx.suspend({resumeOn, timeoutMs})`; handoff gate → `branch` step + suspend aguardando re-qualificação do AE.

### 6.3 O custo real (não está na FSM)

1. **Elo de correlação resposta→workflow (maior peça nova; não opcional).** A resposta do prospect chega como mensagem BullMQ normal no caminho de *reasoning*, **não** como resume de workflow. Nada hoje liga "mensagem inbound do account X" → "retomar cadência suspensa do account X". Precisa de um índice de correlação (chave `(account_id, contact_key, resume_event)`) e de uma sonda antes do raciocínio. **Design detalhado em `2026-05-16-sdr-fase-c-correlation-bridge-design.md`** (decisão registrada: Modelo C — Híbrido).
2. **Fidelidade temporal da cadência.** Reativação é poll-driven (`listExpired()`, intervalo do cleanup job), não scheduler preciso. Aceitável para cadência multi-dia; é constraint conhecida.
3. **Ciclo de vida de versão sob estado longo.** Cadências vivem semanas; `resume-server.ts:117` faz `getExact(workflowId, version)` e retorna 409 se a versão for removida com instâncias vivas (`state-store.ts:171 listActiveVersions()`). Disciplina operacional: manter toda versão de workflow viva até drenar todas as instâncias.

### 6.4 Guards determinísticos (não-negociável)

As transições da FSM (especialmente `Stage1:NewProspect → Stage2:Qualified`) **devem** ter guards determinísticos: score PACT da skill (Fase B) + checagem de presença de evidência — **nunca** juízo do LLM como guard. FSM com guard "o modelo disse que está qualificado" não força nada.

### 6.5 Pré-requisitos não-SDR antes de C

- Compressor de contexto semântico/estruturado: o truncamento por linha atual (`context-builder.ts:57-59`, `lines.slice(0, keepLines)`) deletaria silenciosamente linhas de estado da FSM sob pressão (falha "confidently-wrong on rails"). É mudança no context builder, não no SDR.
- Primitiva de handoff inter-agente: `src/runtime/agent-router.ts` resolve um único surface agent; não existe máquina de estado/handoff inter-agente. Concern de Backend Architect, design próprio.
- Gap de permissões da §5.2 fechado (side-effects autônomos por dias sem humano por mensagem).

### 6.6 Gate de início de C

C só inicia quando: (a) Fase A entregue; (b) L5 demonstra que doutrina+eval produzem veredito de qualificação confiável; (c) skills de B tornaram os guards da FSM determinísticos; (d) elo de correlação + ciclo de versão têm decisão arquitetural própria; (e) gap de permissões fechado. **C não é "B + orquestração"** — o custo real é o elo de correlação e o regime operacional.

---

## 7. Tunáveis de conflito (Ross × Bertuzzi)

Onde os livros conflitam, o desacordo é o sinal de onde o módulo precisa de configuração, não de código fixo. Lar: `src/config/harness-config.ts` + hook A/B (não como sexta context layer disputando budget protegido). Surfaceados na doutrina L0 e nos thresholds das skills L2.

| Conflito | Ross | Bertuzzi | Decisão de design |
|---|---|---|---|
| Peso telefone/voicemail | Email-first (referral-driven) | VM+telefone co-iguais ao email, 2× tudo (dado de contest) | Default multimídia c/ passo de voz/VM obrigatório; peso = parâmetro tunável + A/B (evidência de Bertuzzi é mais forte) |
| Granularidade de papéis | 3 papéis (SDR/AE/AM) | +1 research role, condicional (≥2 triggers) | Contagem de papéis config-driven, gated nas condições de Bertuzzi |
| Speed-to-contact | Resposta imediata | Cético p/ B2B universal; fast-path condicional por intent | Fast-path condicional keyed em intent-score, não SLA global |
| Qualificação | "Sniff test" leve | BANT rejeitado; PACT/PACT2 | PACT como rubrica default; Timing (PACT2) condicional (mercado maduro + displacement) |

Onde **concordam** (vira constante hardcoded): prospector ≠ closer (nunca misturar); cold ≠ warm; pipeline como sistema manufaturado métrico; research/list-building como função distinta.

---

## 8. Métricas & eval

Adotar o modelo de 3 níveis de Bertuzzi diretamente como telemetria do agente:

- **Activities** (controláveis pelo agente; auto-otimizar): toques/dia, tentativas/account, latência de resposta, aderência à cadência.
- **Objectives** (sinais de eval; dirigem iteração de prompt/skill — análogo de engenharia do "coaching"): connect rate (→ alarme qualidade de dados), quality-conversation rate (→ alarme de skill de mensagem; proxy >120s), email reply rate, bad-data rate.
- **Results** (reportar para cima; bandas de alarme): accepted-opp rate (40–50% intro / 65–75% qualified opp), show-up rate ≥75%, $ pipeline, % pipeline total.

KPI primário (leading indicator do Ross): **$ pipeline qualificado/mês**. Cap em respostas-em-voo, não em e-mails enviados. Critério de "release" do agente = os 4 certification gates como suites de eval automatizadas com rubricas objetivas ≥N-de-lista.

---

## 9. Riscos, dependências e sequenciamento

### 9.1 Sequenciamento (fronteiras não estão onde a numeração das camadas sugere)

```
Fase 0  → prova caminho da doutrina            [bloqueia tudo; 1 ponto integração + 1 teste]
Fase A  → L0 + L1 + L5 (completa)              [zero migration; valor imediato]
Fase B  → L2 determinístico subset + L3        [1 migration; força enum + decisão permissões]
Fase C  → L4 FSM/cadência + elo correlação     [gate §6.6; 2 migrations; design próprio do elo]
```

### 9.2 Dependências duras

- L1 (RAG KB) é dependência dura de `qualify_opportunity`/`segment_account` (B) e dos steps de decisão de C.
- Fase 0 é dependência dura de A, B e C (doutrina precisa chegar ao engine).
- C depende de A (eval confiável) + B (guards determinísticos) + decisões arquiteturais próprias (elo de correlação, ciclo de versão, permissões).

### 9.3 Riscos principais

| Risco | Fase | Mitigação |
|---|---|---|
| Doutrina escrita mas nunca lida pelo engine | 0 | Teste de prova via trace antes de escrever conhecimento SDR |
| L0 estoura budget protegido (não-compressível) | A | L0 = poucas centenas de tokens, regras imperativas, condicional ao gate |
| RAG retorna conhecimento mas LLM ignora regra | A | Defesa é L5 (eval), não mais L0 |
| Enum `category` `.strict()` ripple | B | Adicionar `sales` deliberadamente; revisar switches exaustivos |
| Permissões não-enforced em skill com side-effect | B/C | Security Engineer fecha/aceita antes de skill com efeito colateral |
| Truncamento por linha apaga estado da FSM | C | Compressor semântico antes de C (mudança no context builder) |
| Resposta do prospect não correlaciona com cadência | C | Elo de correlação (account→suspend_token) — design próprio, gate de C |
| Estado versionado por semanas | C | Disciplina de manter versões vivas até drenar (`listActiveVersions`) |

### 9.4 Fora de escopo desta spec

- Implementação (qualquer fase). Esta spec é somente desenho.
- Design detalhado do elo de correlação inbound→workflow → **agora especificado em `2026-05-16-sdr-fase-c-correlation-bridge-design.md`** (companheira).
- Design da primitiva de handoff inter-agente (concern de Backend Architect — design próprio).
- Design do compressor de contexto semântico (concern de AI Engineer — design próprio).

---

## 10. Referências de arquivo (verificáveis)

- Caminho da doutrina (Fase 0): `src/runtime/execution-handler.ts:725` (concatenação systemPrompt→input), `execution-handler.ts:196` (`runSurfaceAgentLoop`); `src/reasoning/react.ts:58-63` (`plan()` goal=input), `react.ts:85` (`buildSystemPrompt`), `react.ts:136-141` (payload de trace — sem prompt); `src/context/layers/base-config.layer.ts`.
- L1: `src/rag/retriever.ts`, `src/rag/vector-store.ts`, `src/rag/embedder.ts`.
- L2 (colisão): `src/skills/skill-manifest.schema.ts:48,51`; `src/skills/skill-runtime.ts`; `src/skills-builtin/`.
- L3 (template): `src/context/layers/memory.layer.ts`; registro `src/context/layers/index.ts`; compressor `src/context/context-builder.ts:32-64`.
- L4 (engine existente): `src/workflow/types.ts:86`, `src/workflow/state-store.ts:145` (`listExpired`), `state-store.ts:171` (`listActiveVersions`), `src/workflow/resume-server.ts:117`, `src/runtime/execution-handler.ts:607-612`, `src/bootstrap/stages.ts:250`.
- L5: `src/evals/runner.ts`, `src/evals/registry.ts`, `src/evals/repository.ts`.
- Tunáveis: `src/config/harness-config.ts`.
- Roteamento (parede da Fase C): `src/agents/registry.ts`, `src/runtime/agent-router.ts`.
- Fonte do conhecimento SDR: *Predictable Revenue* e *The Sales Development Playbook* (cópias locais do autor, não incluídas).
