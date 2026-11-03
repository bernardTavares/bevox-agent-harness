# Go-live do bevox-harness via bevox-hetzner-mcp — Design

- **Data:** 2026-05-28
- **Status:** Aceita (escopo: primeiro deploy do harness em produção via MCP). Implementação fica a cargo do Claude Code rodando dentro de `bevox-harness/`.
- **Pré-requisitos satisfeitos:**
  - bevox-hetzner-mcp daemon rodando (`bevox-daemon.service`, REST em `127.0.0.1:8787`, MCP server in-process).
  - Token `agent:bevox-harness` com as 19 capabilities (BEVOX_HETZNER_MCP_TOKEN em `bevox-harness/.env`).
  - Bridge `dist/bin/hetzner-bridge.js` buildado e validado por smoke test (19 tools/list + get_state 200 OK).
  - `mcp.config.json` declarando o server `bevox-hetzner` via stdio.
- **Spec do bridge:** `docs/superpowers/specs/2026-05-28-bevox-hetzner-mcp-bridge.md`.
- **Runbook operacional do bridge:** `docs/runbooks/bevox-hetzner-mcp-bridge.md`.

---

## 1. Objetivo, preciso

Subir o **primeiro nó de produção do bevox-harness** em um servidor Hetzner Cloud — provisionamento + deploy do container + integração com Postgres e Redis — usando exclusivamente os 19 tools do bevox-hetzner-mcp via o bridge stdio.

Aceitação binária:
- Um servidor Hetzner Cloud `harness-prod-1` existe, observado em `get_state`.
- O container `bevox-harness` está rodando nesse server (Docker via SSH).
- O harness consome jobs da fila BullMQ configurada e produz callbacks pra `BEVOX_CALLBACK_BASE_URL`.
- Re-aplicar o manifesto produz `plan.ops = []` (idempotência por design, ground rule do bevox-hetzner-mcp).

## 2. Topologia alvo

```
                 ┌──────────────────────────────────────────────────────┐
                 │            Hetzner Cloud — server: harness-prod-1     │
                 │              location: nbg1   type: cx32              │
                 │                                                       │
                 │    docker container: bevox-harness                    │
                 │      image: <registry>/bevox-harness:<tag>            │
                 │      env:                                             │
                 │        DATABASE_URL → postgres container (local)      │
                 │        REDIS_URL    → redis container (local)         │
                 │        OPENAI_API_KEY, BEVOX_CALLBACK_*, etc.         │
                 │                                                       │
                 │    docker container: postgres:16-alpine               │
                 │      volume: /var/lib/bevox-pg-data                   │
                 │      port: 127.0.0.1:5432 (bind interno apenas)       │
                 │                                                       │
                 │    docker container: redis:7-alpine                   │
                 │      volume: /var/lib/bevox-redis-data                │
                 │      port: 127.0.0.1:6379 (bind interno apenas)       │
                 └────────────────────────┬──────────────────────────────┘
                                          │ outbound HTTPS
                                          ▼
                            ┌──────────────────────────────┐
                            │  bevox-backend (callbacks)   │
                            │  OpenAI / Gemini             │
                            │  Calendar service            │
                            └──────────────────────────────┘
```

### 2.1 Decisões topológicas e por quê

- **Single-host, três containers Docker.** O harness é um worker outbound-only (consume BullMQ, produce callbacks HTTP) — não expõe porta pública nem precisa de LB/ingress/cert. Manter Postgres + Redis no mesmo host minimiza custo, footprint de rede e número de superfícies de ataque. Modelo idêntico ao `docker-compose.yml` já checked-in.
- **Sem firewall público.** Postgres e Redis fazem bind apenas em `127.0.0.1` do server (Docker port mapping localhost-only). Tráfego de entrada via SSH (gerenciado pelo `SSH_HOST` do bevox-hetzner-mcp). Nenhum `set_firewall` na borda — não há serviço inbound público a proteger.
- **Sem DNS público.** Sem hostname. Conexão entre serviços é por loopback no mesmo host; orquestração externa fala com a fila Redis (cross-cluster via VPN/peering existente fora desta spec) ou via callback HTTP outbound.
- **Sem `set_ingress` / `set_load_balancer` / `set_certificate` / `set_primary_ip` / `expose_service`.** Esses 5 tools v2 são para serviços com borda pública — o harness não tem.
- **Volume durável para Postgres.** `volume:pg-data` no manifest. Backup automatizado via `snapshot` agendado (cron expression no manifest, executado pelo daemon).

## 3. Manifesto canônico

Arquivo: `infra/manifest.harness-prod.yaml` (NOVO, dentro do repo do harness — gitignored se contiver valores literais não-secret-ref).

```yaml
# infra/manifest.harness-prod.yaml
#
# Desired state para o primeiro nó de produção do bevox-harness.
# Aplicar via: mcp:bevox-hetzner.apply_manifest { manifestYaml: <conteúdo> }
# Re-aplicar é a recuperação. Re-aplicar com 0 mudanças = noop por design.

servers:
  - name: harness-prod-1
    type: cx32              # 4 vCPU / 8GB RAM — folga p/ harness + pg + redis
    location: nbg1          # Nuremberg, mais barato pra workloads sem latência crítica
    image: ubuntu-24.04

volumes:
  - name: pg-data
    server: harness-prod-1
    size: 40                # GB — folga p/ migrations, workflow_state, embeddings
  - name: redis-data
    server: harness-prod-1
    size: 5

services:
  # NOTA: o Docker provider do bevox-hetzner-mcp usa SSH pra deploy. A ordem
  # de declaração não dita ordem de apply (o reconciler resolve por
  # dependência). Mas SEMÂNTICAMENTE pg/redis vêm antes do harness pois o
  # harness os consome no boot.

  - name: postgres
    server: harness-prod-1
    image: postgres:16-alpine
    replicas: 1
    env:
      POSTGRES_USER: harness
      POSTGRES_DB: bevox_harness
      POSTGRES_PASSWORD: secret:harness-pg-password   # ver §6 — caveat v1
    volumes:
      - { source: pg-data, target: /var/lib/postgresql/data }
    ports:
      - "127.0.0.1:5432:5432"

  - name: redis
    server: harness-prod-1
    image: redis:7-alpine
    replicas: 1
    volumes:
      - { source: redis-data, target: /data }
    ports:
      - "127.0.0.1:6379:6379"
    cmd: ["redis-server", "--appendonly", "yes"]

  - name: bevox-harness
    server: harness-prod-1
    image: ghcr.io/bernardtavares/bevox-agent-harness:latest   # ver §5 — registry/tag
    replicas: 1
    env:
      NODE_ENV: production
      HARNESS_LOG_LEVEL: info
      DATABASE_URL: postgres://harness:secret:harness-pg-password@postgres:5432/bevox_harness
      REDIS_URL: redis://redis:6379
      BEVOX_CALLBACK_BASE_URL: secret:bevox-callback-base-url
      BEVOX_DB_URL: secret:bevox-db-url
      CALENDAR_SERVICE_URL: secret:calendar-service-url
      OPENAI_API_KEY: secret:openai-api-key
      HARNESS_QUEUE_NAME: execution.dispatch.agent_harness
      HARNESS_MAX_EXECUTION_TIME_MS: "120000"
      BEVOX_DEFAULT_ACCOUNT_ID: secret:bevox-default-account-id
    depends_on: [postgres, redis]

backups:
  - target: volume:pg-data
    schedule: "0 3 * * *"   # 03:00 UTC diário
    retention: 14d
  - target: volume:redis-data
    schedule: "0 4 * * 0"   # domingo 04:00 UTC
    retention: 4w
```

### 3.1 Pontos a confirmar contra o domínio v1 do bevox-hetzner-mcp

O Claude Code do harness DEVE, antes de chamar `apply_manifest`, validar o YAML via `resolve_selector` ou via uma sonda `apply_manifest --dry-run`-equivalente (consultar `core/src/domain/desired-state.ts` no projeto canônico para o schema Zod real). Campos que esta spec ASSUME existirem e que podem ter nome ligeiramente diferente no v1:

- `services[].depends_on` — pode chamar `requires` ou ser implícito por referência. **VERIFICAR**.
- `services[].cmd` — pode ser `command`. **VERIFICAR**.
- `services[].ports` — formato Docker `HOST:CONTAINER` vs. objeto estruturado. **VERIFICAR**.
- `volumes[].server` — pode ser `attached_to` ou `host`. **VERIFICAR**.
- `backups[].target` — sintaxe `volume:<name>` vs `volume/<name>`. **VERIFICAR**.

Se algum desses divergir, ajustar o manifest para casar com o schema do daemon — esta spec é o desejo de alto nível, o schema do daemon é fonte de verdade.

## 4. Sequência operacional

Todas as chamadas via MCP tool `bevox-hetzner.<tool>` (cliente é o Claude Code dentro do harness, transport é o bridge stdio configurado em `mcp.config.json`).

```
 0. Pré-flight
    └─ bevox-hetzner.health             — daemon up?
    └─ bevox-hetzner.get_state          — confirmar baseline vazio
                                          (servers=0 services=0)

 1. Provisionar a casca declarativa SEM o harness ainda
    └─ bevox-hetzner.apply_manifest     — manifesto com TUDO menos
                                          services[].name=="bevox-harness"
       └─ daemon cria server + volumes  (idempotente)
       └─ daemon sobe postgres + redis  (Docker via SSH)
    └─ Esperar:
       └─ get_state.servers[name=harness-prod-1].observed == ready
       └─ get_state.services[name=postgres].observed == running
       └─ get_state.services[name=redis].observed == running

 2. Executar migrations no Postgres recém-subido
    └─ Fora do bevox-hetzner-mcp: o daemon NÃO tem tool de migration.
       Opções:
       (a) SSH manual: `ssh user@harness-prod-1 docker exec postgres
            psql -U harness -d bevox_harness -f /migrations/*.sql`
       (b) "init container" no manifest (replicas:0 + run-once) — exige
            confirmar suporte no Docker provider v1
       (c) Embed migrations no entrypoint da imagem do harness — execução
            no boot do worker (recomendado a longo prazo)
    Para o primeiro go-live, escolher (a). Documentar no runbook.

 3. Deploy do harness — segundo apply_manifest, agora COMPLETO
    └─ bevox-hetzner.apply_manifest     — manifesto inteiro
       └─ daemon detecta que server/volumes/pg/redis já existem (noop)
       └─ daemon sobe service bevox-harness
    └─ Esperar:
       └─ get_state.services[name=bevox-harness].observed == running

 4. Verificação (§5)
```

### 4.1 Por que dois `apply_manifest` em vez de um?

Estritamente o reconciler é idempotente e poderia receber o manifest inteiro de cara, mas as migrations precisam rodar ENTRE o pg estar up e o harness subir. Um único apply tentaria subir o harness antes da migration — e o harness valida o schema no boot (`bootstrap/stages.ts:infra-check` faz DB ping; etapas posteriores assumem tabelas). Dois applies dão controle do gate de migration.

Alternativa: fazer (c) acima (migrations no entrypoint) numa segunda PR; aí um único apply basta.

## 5. Verificação pós-deploy

Aceitação é binária — cada item DEVE passar:

```
[ ] bevox-hetzner.health → status:"ok" para providers + breakers
[ ] bevox-hetzner.get_state → exatamente 1 server (harness-prod-1, ready),
    2 volumes (pg-data, redis-data, attached), 3 services (postgres, redis,
    bevox-harness, todos running com observed.replicas == 1)
[ ] bevox-hetzner.diff { source: "observed" } → diff vazio
    (nenhum drift entre desejado e observado)
[ ] Re-aplicar o manifesto (apply_manifest) → plan.ops == []
    (idempotência por design, ground rule #2 do bevox-hetzner-mcp)
[ ] SSH ao server e `docker logs bevox-harness | head -50` mostra:
    - "bootstrap: infra-check ok"
    - "bootstrap: load-tools-permissions ok (13 tools)"
    - "consumer attached to queue execution.dispatch.agent_harness"
    Sem ERROR / FATAL no log de boot.
[ ] Smoke job: enfileirar via `npm run smoke:enqueue` (do diretório do
    repo bevox-backend que controla a fila) ou via redis-cli direto.
    Esperar callback HTTP chegar em BEVOX_CALLBACK_BASE_URL dentro de 30s.
```

## 6. Caveats v1 (gaps conhecidos no bevox-hetzner-mcp)

**Status pós-2026-05-28**: dos 4 caveats originais, 1 foi resolvido (§6.1), 1 era falso (§6.3), 1 segue em pé com workaround (§6.2), 1 segue postponado (§6.4).

### 6.1 Secret resolver — RESOLVIDO em 2026-05-28 ✅

**Estado**: shipped via PR #26 (`feat(core): real secret resolver v1 (sops+age)`). O stub `createStubSecretResolver` foi substituído por `createSopsAgeSecretResolver` real (sops+age subprocess on-demand). Spec: `bevox-hetzner-mcp/docs/specs/2026-05-28-secret-resolver-real-v1.md` (Aceita 2026-05-28).

**Pré-requisitos operacionais antes do go-live do harness**:
1. Operator faz setup §5.1 da runbook (`bevox-hetzner-mcp/deploy/runbook-secrets-go-live.md`): `age-keygen`, init sops file, append `SECRETS_FILE` + `SOPS_AGE_KEY_FILE` ao `core/.env`, restart daemon.
2. Secrets do harness (DB password, OPENAI_API_KEY, etc.) são adicionados via `sops --set '["nome"] "valor"' file.enc.yaml`.
3. Manifest do harness referencia `secret:<nome>` em `services[].env`.

O resolver decripta on-demand durante `apply()`, injeta o valor no `Engine.Env` do container Docker, e o valor NUNCA aparece em plan/dry_run/log/StateEvent/HTTP response/error message (invariantes L1-L9 da spec §3).

### 6.2 Sem migration runner — segue em pé

`core/src/agent/capability.ts` não declara tool de migration nas listas `ALL_TOOLS` ou `V2_TOOLS`. Workaround documentado em §4 (SSH manual).

**Em progresso**: brainstorm da spec do migration runner está agendado como próximo bloco de trabalho no bevox-hetzner-mcp. Quando shipper, este caveat sai.

### 6.3 Health-aggregation endpoint — FALSO GAP ✅

**Verificado 2026-05-28**: `GET /api/health` retorna **HTTP 200** com o aggregation real wired. Exemplo de resposta no daemon de produção:

```json
{
  "circuit_breakers": [{"name":"hetzner-cloud","state":"closed","failures":0,"max_failures":5}, ...],
  "degraded": [], "blocked": [], "drift": [],
  "reconciler": {"state":"idle", "last_cycle":"...", "total_cycles": 648}
}
```

A confusão original (que originou este caveat) foi um teste de curl na **porta errada (8080 em vez de 8787)**. O daemon `bevox-daemon.service` escuta em `127.0.0.1:8787` por default (`core/src/config.ts:189` → `PORT: intKnob(8787, 0)`); a porta 8080 é de outros serviços que estavam rodando no host.

A wiring está em `bevox-hetzner-mcp/core/src/server.ts:465-472` (constrói `HealthSource` over breaker registry + reconciler snapshots) e `:513` (passa pro `createRestServer`). Item §5 do checklist (`bevox-hetzner.health` retorna status estruturado) está coberto.

### 6.4 Sem rotação automática de credenciais — segue postponado

O token `agent:bevox-harness` foi injetado manualmente em `core/.env` (`AGENT_CREDENTIALS`). Rotação exige editar o JSON + `sudo systemctl restart bevox-daemon`. Aceitável para v1 — está na lista de não-objetivos do projeto canônico. Será endereçado em ciclo futuro (spec separada quando priorizada).

## 7. Rollback

`bevox-hetzner-mcp` é **fail-safe, nunca fail-deleting** (ground rule #3). Um apply que falhe NUNCA destrói recursos não solicitados. Cenários de rollback:

| Cenário | Ação |
|---|---|
| `apply_manifest` retorna `{ status: "error" }` mid-way | Re-aplicar (o reconciler converge). Inspecionar `events` tool para a causa. |
| Service `bevox-harness` sobe mas crasha em loop | Não há tool `restart`. Editar o manifest (downgrade `image:` para tag anterior) → `apply_manifest`. Ou `destroy` o service e re-aplicar. |
| Servidor `harness-prod-1` precisa ser DESTRUIDO | `bevox-hetzner.destroy { entity: "server:harness-prod-1" }` — passa pelo Approval Gate (TTL pendente, requer aprovação humana). Spec do gate: `bevox-hetzner-mcp/docs/specs/2026-05-17`. |
| Restaurar Postgres de backup | `bevox-hetzner.restore { target: "volume:pg-data", snapshotId: "<id from events>" }`. |

NÃO existe rollback automático destrutivo. Não tentar implementar um — viola a invariante.

## 8. Não-objetivos (YAGNI v1)

- **CI/CD do bevox-harness publicando imagem.** O manifest assume `ghcr.io/bernardtavares/bevox-agent-harness:latest`. Se o release workflow do harness não publica nesse path, ajustar o tag ANTES do apply. Configurar release-to-GHCR é outra spec.
- **Multi-host / HA do harness.** Single instance v1. Escalar replicas vai cair em config Docker-only; HA real (multi-host) exige Bloco B do bevox-hetzner-mcp (não shipado).
- **Observabilidade externa (Prometheus / Grafana).** Logs Pino vão pra stdout do container e Docker daemon. Para v1 basta `docker logs`. Painel é outra spec.
- **Disaster recovery cross-region.** restic backups em uma região (Nuremberg). DR multi-região é Bloco B.
- **Rotação de secrets.** Operator faz via `sops` CLI + restart do daemon (`bevox-hetzner-mcp/deploy/runbook-secrets-go-live.md` §5.4). Automação programática (MCP tool `rotate_secret`) está em §10 não-objetivos.
- **Public ingress.** Harness é worker, não API. Sem hostname, sem cert, sem LB.

## 9. Critérios de aceitação desta spec (não da implementação)

- [ ] O manifest §3 valida contra o schema Zod do bevox-hetzner-mcp (`desired-state.ts`).
- [ ] O Claude Code do harness consegue executar a sequência §4 sem precisar pedir capability adicional (token tem todas as 19 caps).
- [ ] Os caveats §6 estão endereçados: §6.1 resolvido pré-go-live via PR #26 do bevox-hetzner-mcp; §6.2 segue com SSH manual; §6.3 falso gap; §6.4 postponado.
- [ ] Verificação §5 passa após o segundo `apply_manifest`.

## 10. Artefatos esperados após implementação

```
bevox-harness/
  infra/
    manifest.harness-prod.yaml         — manifest desta spec, possivelmente ajustado §3.1
    # §6.1 — secrets agora resolvem via sops+age no daemon (PR #26). Operator
    # setup migrou pra bevox-hetzner-mcp/deploy/runbook-secrets-go-live.md.
    # Sem mais arquivo secrets-bootstrap.md no harness.
  docs/superpowers/plans/
    2026-05-XX-go-live-via-hetzner-mcp.md   — plano TDD-sized (gerado por /new-plan)
  docs/runbooks/
    bevox-harness-prod-deploy.md       — operação ongoing pós go-live (rotina,
                                         backup verify, restart)
```

## 11. Referências

- bevox-hetzner-mcp v1 spec: `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` (FROZEN).
- bevox-hetzner-mcp v2 contract: `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md` (FROZEN).
- Tabela tool→REST do bridge: `bevox-harness/docs/superpowers/specs/2026-05-28-bevox-hetzner-mcp-bridge.md` §2.1.
- Manifesto v1 minimal (oráculo): `bevox-hetzner-mcp/core/test/fixtures/manifest-ok.yaml`.
- Ground rules invariantes: `bevox-hetzner-mcp/CONTRIBUTING.md` §"Ground rules" (idempotência, fail-safe, secret hygiene, actor capture, spec-first).
