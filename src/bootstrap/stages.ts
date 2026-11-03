import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Redis } from "ioredis";
import type { Pool } from "pg";

import { MemoryCondenserAgent } from "../agents/pipeline/memory-condenser.agent.js";
import { MemoryExtractorAgent } from "../agents/pipeline/memory-extractor.agent.js";
import { MessageAnalyzerAgent } from "../agents/pipeline/message-analyzer.agent.js";
import { AgentRegistry } from "../agents/registry.js";
import { createSchedulerAgent } from "../agents/surface/scheduler.agent.js";
import { getEnv } from "../config/env.js";
import { getHarnessConfig } from "../config/harness-config.js";
import { isDevModeEnabled } from "../dev/event-bus.js";
import { startDevWsServer } from "../dev/ws-server.js";
import { createLLMGateway } from "../integration/llm-gateway.js";
import { createLLMEmbedder } from "../integration/llm/embedder.js";
import { createCondenseQueue } from "../integration/condense-queue.js";
import { MessageEmbeddingIndexer } from "../memory/message-embedding-indexer.js";
import { setCondenseQueue, setMessageIndexer, setSemanticRecall } from "../memory/registry.js";
import { RagSemanticRecall } from "../memory/semantic-recall.js";
import { CachingEmbedder } from "../rag/embedder.js";
import { PgVectorStore } from "../rag/vector-store.js";
import { RagRetriever } from "../rag/retriever.js";
import { setRetriever } from "../rag/registry.js";
import { EvalQueue } from "../evals/eval-queue.js";
import { startEvalWorker } from "../evals/eval-worker.js";
import {
  setEvalQueue,
  setEvalWorker,
  setSamplingPolicy,
  setEnabledScorers,
} from "../evals/registry.js";
import { EvalResultsRepository } from "../evals/repository.js";
import { EvalRunner } from "../evals/runner.js";
import { parseSamplingPolicy } from "../evals/sampler.js";
import { buildScorers } from "../evals/scorer-factory.js";
import { createLogger } from "../config/logger.js";
import { startConsumer } from "../integration/bullmq-consumer.js";
import { initTracer } from "../observability/tracer.js";
import type { AgentRouter } from "../runtime/agent-router.js";
import { createAgentRouter } from "../runtime/agent-router.js";
import { PermissionAuditLogger, setPermissionAuditLogger } from "../security/audit.js";
import { ExecutionAuditLogger, setExecutionAuditLogger } from "../security/execution-audit.js";
import { SkillLoader } from "../skills/skill-loader.js";
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
import { RateLimiter, setRateLimiter } from "../security/rate-limiter.js";
import { bookAppointmentWorkflow } from "../workflow/examples/book-appointment.js";
import { sdrCadenceWorkflow } from "../workflow/definitions/sdr-cadence.js";
import { WorkflowRegistry } from "../workflow/registry.js";
import { WorkflowStateStore } from "../workflow/state-store.js";
import { WorkflowCleanupJob } from "../workflow/cleanup.js";
import { CorrelationStore } from "../workflow/correlation-store.js";
import { makeCorrelationProjectionHandler } from "../workflow/correlation-projection.hook.js";
import { getHookBus } from "../runtime/hooks/index.js";
import { loadMcpClientConfig } from "../config/mcp-servers.js";
import { connectMcpServer } from "../mcp/client.js";
import { McpClientRegistry } from "../mcp/client-registry.js";
import { adaptMcpToolToSkill } from "../mcp/mcp-tool-adapter.js";
import { startMcpHealthLoop } from "../mcp/health.js";
import type { LoadedSkill } from "../skills/skill-runtime.js";

export interface BootstrapContext {
  db: Pool;
  redis: Redis;
}

export interface BootstrapStage {
  name: string;
  execute: () => Promise<void>;
}

let _ctx: BootstrapContext;
let _agentRouter: AgentRouter | undefined;
let _workflowStateStore: WorkflowStateStore | undefined;
let _workflowCleanupJob: WorkflowCleanupJob | undefined;

export function getWorkflowStateStore(): WorkflowStateStore | undefined {
  return _workflowStateStore;
}

export function getWorkflowCleanupJob(): WorkflowCleanupJob | undefined {
  return _workflowCleanupJob;
}

export function setBootstrapContext(ctx: BootstrapContext): void {
  _ctx = ctx;
}

export function getAgentRouter(): AgentRouter | undefined {
  return _agentRouter;
}

// Known tool names for pre-registration validation in stage 3
const KNOWN_TOOL_NAMES = [
  "read-calendar",
  "list-appointments",
  "create-appointment",
  "cancel-appointment",
  "reschedule-appointment",
  "waitlist-add",
  "send-message",
  "request-human",
  "read-profile",
  "write-profile",
  "write-fact",
  "search-faq",
];

/**
 * Sprint B.2 — connect external MCP servers and register their tools as
 * synthetic skills (`mcp:<server>.<tool>`).
 *
 * Graceful degradation: a single unreachable server logs an error and is
 * skipped — the rest of the bootstrap proceeds. Set `MCP_REQUIRE_ALL=true`
 * to invert this and fail-fast on any connection error.
 */
export async function loadMcpClientsStage(): Promise<void> {
  const config = await loadMcpClientConfig();
  if (!config) {
    console.log("[bootstrap] mcp client disabled or no config — skipping");
    return;
  }

  const mcpReg = McpClientRegistry.getInstance();
  const reg = UnifiedToolRegistry.getInstance();
  const env = getEnv();
  const requireAll = env.MCP_REQUIRE_ALL;
  const timeoutMs = config.defaults.timeoutMs ?? env.MCP_CLIENT_TIMEOUT_MS;

  for (const [serverId, server] of Object.entries(config.servers)) {
    try {
      const connected = await connectMcpServer(serverId, server);
      const toolsResponse = await connected.client.listTools();
      const skills: LoadedSkill[] = [];

      for (const tool of toolsResponse.tools) {
        const skill = adaptMcpToolToSkill(tool, {
          serverId,
          client: connected.client,
          timeoutMs,
        });
        if (!skill) continue; // invalid schema or manifest — already logged
        try {
          reg.register(skill);
          skills.push(skill);
        } catch (err) {
          console.warn(
            `[bootstrap] mcp skill register collision serverId=${serverId} tool=${tool.name}:`,
            err,
          );
        }
      }

      mcpReg.add(connected, skills);
      console.log(`[bootstrap] mcp server connected serverId=${serverId} skills=${skills.length}`);
    } catch (err) {
      if (requireAll) {
        throw new Error(
          `MCP server "${serverId}" unreachable and MCP_REQUIRE_ALL=true: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.error(
        `[bootstrap] mcp server connection failed serverId=${serverId} — continuing without it:`,
        err,
      );
    }
  }

  // Kick off the periodic heartbeat (no-op if zero servers connected).
  startMcpHealthLoop();
}

export function buildStages(ctx: BootstrapContext): BootstrapStage[] {
  return [
    {
      name: "infra-check",
      async execute() {
        // DB ping
        await ctx.db.query("SELECT 1");
        // Redis ping
        const pong = await ctx.redis.ping();
        if (pong !== "PONG") throw new Error("Redis did not respond with PONG");
      },
    },
    {
      name: "load-config",
      async execute() {
        // Both calls validate all config — they throw/exit if env is invalid.
        getEnv();
        getHarnessConfig();
      },
    },
    {
      name: "init-observability",
      async execute() {
        // No-op when OTEL_ENABLED=false. Idempotent.
        initTracer();
      },
    },
    {
      name: "register-agents",
      async execute() {
        const agentRegistry = AgentRegistry.getInstance();

        // Register pipeline agents
        agentRegistry.register(new MessageAnalyzerAgent(ctx.db));
        agentRegistry.register(new MemoryExtractorAgent(ctx.db));
        // Sprint D.3 — memory-condenser is registered unconditionally so
        // operators can introspect it, but only executes when invoked by the
        // dedicated `harness.memory.condense` worker.
        agentRegistry.register(new MemoryCondenserAgent());

        // Register surface agents
        agentRegistry.register(createSchedulerAgent());

        // Validate required tools are listed (names only — not yet resolved)
        for (const agent of agentRegistry
          .listByType("surface")
          .concat(agentRegistry.listByType("pipeline"))) {
          for (const toolName of agent.definition.permissions.required) {
            if (toolName !== "*" && !KNOWN_TOOL_NAMES.includes(toolName)) {
              throw new Error(
                `Agent "${agent.definition.name}" requires unknown tool "${toolName}"`,
              );
            }
          }
        }

        // Build and store the AgentRouter
        _agentRouter = createAgentRouter();

        console.log(
          `[bootstrap] Agents registered: ${agentRegistry.listByType("pipeline").length} pipeline, ${agentRegistry.listByType("surface").length} surface`,
        );
      },
    },
    {
      // Sprint C.1 — registers declarative workflows and provisions the
      // shared state store. Inserted between `register-agents` and
      // `warmup-pipeline`; CLAUDE.md's "7 stages" wording is now indicative,
      // not exact.
      name: "register-workflows",
      async execute() {
        const registry = WorkflowRegistry.getInstance();
        registry.register(bookAppointmentWorkflow);
        // Fase C §6 — SDR cadence: Account-Status FSM + 7-touch skeleton
        registry.register(sdrCadenceWorkflow);

        _workflowStateStore = new WorkflowStateStore(ctx.db);
        _workflowCleanupJob = new WorkflowCleanupJob({
          store: _workflowStateStore,
          intervalMs: getEnv().WORKFLOW_CLEANUP_INTERVAL_MS,
        });

        // Fase C §5 — register the correlation projection hook so that
        // workflow lifecycle events (onSuspended / onResumed / onWorkflowTerminal)
        // automatically populate the `workflow_correlation` table. The store
        // shares the same DB pool already used by WorkflowStateStore.
        const correlationStore = new CorrelationStore(ctx.db);
        getHookBus().register(makeCorrelationProjectionHandler(correlationStore));

        // Validate every agent's `workflow` reference (hard fail per
        // AgentDefinition JSDoc).
        const agentRegistry = AgentRegistry.getInstance();
        const surfaceAgents = agentRegistry.listByType("surface");
        for (const agent of surfaceAgents) {
          const wfId = agent.definition.workflow;
          if (wfId && !registry.has(wfId)) {
            throw new Error(
              `Agent "${agent.definition.name}" references workflow "${wfId}" but it is not registered`,
            );
          }
        }

        console.log(`[bootstrap] Workflows registered: ${registry.list().length}`);
      },
    },
    {
      name: "warmup-pipeline",
      async execute() {
        // Validate LLM connectivity by checking that the CredentialPool has at
        // least one key for the default provider. Actual warm-up inference is
        // deferred to avoid cold-start latency at boot.
        const harnessConfig = getHarnessConfig();
        const provider = harnessConfig.llm.provider;
        const { getCredentialPool } = await import("../integration/llm/credential-pool.js");
        const pool = getCredentialPool();
        if (!pool.has(provider)) {
          console.warn(
            `[bootstrap] WARNING: DEFAULT_LLM_PROVIDER=${provider} but no credentials registered ` +
              `(set ${provider.toUpperCase()}_API_KEY or ${provider.toUpperCase()}_API_KEYS)`,
          );
        }
        console.log(
          `[bootstrap] Pipeline warmup: LLM provider=${provider} model=${harnessConfig.llm.model} ` +
            `pool_size=${pool.size(provider)}`,
        );
      },
    },
    {
      name: "load-tools-permissions",
      async execute() {
        // Wire permission audit logger (Phase 3 — requires migration 002).
        setPermissionAuditLogger(new PermissionAuditLogger(ctx.db));

        // PERM-03 — execution-audit logger (escalations + mutations).
        // Requires migration 013_execution_audit_extension.sql.
        setExecutionAuditLogger(new ExecutionAuditLogger(ctx.db));

        // Wire rate limiter (Phase 3 — Redis sliding window).
        setRateLimiter(new RateLimiter(ctx.redis));

        const reg = UnifiedToolRegistry.getInstance();
        const env = getEnv();

        // 1) Load built-in skills (manifest-driven). `__dirname` is
        //    `dist/bootstrap` in prod and `src/bootstrap` in dev — both
        //    siblings resolve correctly to `../skills-builtin`.
        const disabled = new Set(
          env.SKILLS_DISABLED.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        const loader = new SkillLoader({ disabled });
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const builtinRoot = path.resolve(__dirname, "..", "skills-builtin");
        const builtinSkills = await loader.loadFromPath(builtinRoot);
        for (const skill of builtinSkills) {
          reg.register(skill);
        }

        // 2) Optional external skills via SKILLS_PATH (opt-in in prod).
        if (env.SKILLS_PATH) {
          const isProd = env.NODE_ENV === "production";
          if (isProd && !env.ALLOW_EXTERNAL_SKILLS) {
            console.warn(
              `[bootstrap] SKILLS_PATH=${env.SKILLS_PATH} ignored in production — set ALLOW_EXTERNAL_SKILLS=true to opt in`,
            );
          } else {
            const external = await loader.loadFromPath(env.SKILLS_PATH);
            for (const skill of external) {
              reg.register(skill);
            }
            console.warn(
              `[bootstrap] loaded ${external.length} external skill(s) from ${env.SKILLS_PATH} — trusted boundary`,
            );
          }
        }

        // Skills are self-contained (SKILLS-05) — no legacy tool mirror needed.

        const agentRegistry = AgentRegistry.getInstance();

        // For each agent, verify all required tools are actually registered
        for (const agent of agentRegistry
          .listByType("surface")
          .concat(agentRegistry.listByType("pipeline"))) {
          for (const toolName of agent.definition.permissions.required) {
            if (toolName === "*") continue; // wildcard — skip validation
            if (!reg.has(toolName)) {
              throw new Error(
                `Stage 5 FATAL: required tool "${toolName}" for agent "${agent.definition.name}" is not registered`,
              );
            }
          }
        }

        console.log(
          `[bootstrap] Tools and permissions loaded: ${reg.all().length} skills registered`,
        );
      },
    },
    {
      name: "load-mcp-clients",
      async execute() {
        await loadMcpClientsStage();
      },
    },
    {
      // Sprint D.2 — wire the RAG retriever for surface tools (`search-faq`).
      // Opt-in via RAG_ENABLED=true to avoid bootstrapping embedder credentials
      // in environments without OPENAI/GEMINI keys (e.g. CI). When disabled,
      // tools call getRetriever() → undefined and degrade gracefully.
      name: "init-rag",
      async execute() {
        const env = getEnv();
        if (!env.RAG_ENABLED) {
          console.log("[bootstrap] rag disabled (RAG_ENABLED=false) — skipping");
          return;
        }
        // Multi-dim guard (G correção): schema is vector(1536); reject mismatch.
        if (env.RAG_EMBEDDING_DIM !== 1536) {
          throw new Error(
            `init-rag: RAG_EMBEDDING_DIM=${env.RAG_EMBEDDING_DIM} not supported. ` +
              `Schema rag_chunks.embedding is vector(1536). Add a migration before changing.`,
          );
        }
        // Pre-flight: extension must exist (DBA may need to CREATE EXTENSION manually).
        const ext = await ctx.db.query<{ ok: number }>(
          "SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'",
        );
        if (ext.rowCount === 0) {
          throw new Error(
            "init-rag: pgvector extension not installed. Run `CREATE EXTENSION vector;` (DBA) " +
              "then apply migrations/006_rag_embeddings.sql.",
          );
        }

        const llmEmbedder = createLLMEmbedder({ model: env.RAG_EMBEDDING_MODEL });
        const cachingEmbedder = new CachingEmbedder(llmEmbedder, ctx.db, {
          model: env.RAG_EMBEDDING_MODEL,
          dim: env.RAG_EMBEDDING_DIM,
        });
        const store = new PgVectorStore(ctx.db);
        const retriever = new RagRetriever(cachingEmbedder, store);
        setRetriever(retriever);
        console.log(
          `[bootstrap] RAG retriever wired: model=${env.RAG_EMBEDDING_MODEL} dim=${env.RAG_EMBEDDING_DIM} top_k=${env.RAG_TOP_K_DEFAULT}`,
        );
      },
    },
    {
      // Sprint D.3 — wires the message indexer, semantic recall, and the
      // condense queue producer. All gated by individual feature flags.
      // Defaults are OFF so adding D.3 introduces zero behaviour change.
      // Hard dependency: pgvector (created by migration 006).
      name: "init-memory-d3",
      async execute() {
        const env = getEnv();
        const anyEnabled =
          env.MEMORY_SEMANTIC_RECALL_ENABLED ||
          env.MEMORY_INDEXER_ENABLED ||
          env.MEMORY_CONDENSE_ENABLED;
        if (!anyEnabled) {
          console.log("[bootstrap] memory D.3 disabled (all MEMORY_* flags off) — skipping");
          return;
        }

        // Pre-flight: pgvector must be available before D.3 features can wire.
        const ext = await ctx.db.query<{ ok: number }>(
          "SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'",
        );
        if (ext.rowCount === 0) {
          throw new Error(
            "init-memory-d3: pgvector extension not installed. Apply migration 006 (D.2) first.",
          );
        }

        // Embedder is shared with RAG; build one if RAG didn't already.
        const llmEmbedder = createLLMEmbedder({ model: env.RAG_EMBEDDING_MODEL });
        const cachingEmbedder = new CachingEmbedder(llmEmbedder, ctx.db, {
          model: env.RAG_EMBEDDING_MODEL,
          dim: env.RAG_EMBEDDING_DIM,
        });

        if (env.MEMORY_INDEXER_ENABLED) {
          setMessageIndexer(new MessageEmbeddingIndexer(ctx.db, cachingEmbedder));
          console.log("[bootstrap] D.3 message indexer wired");
        }
        if (env.MEMORY_SEMANTIC_RECALL_ENABLED) {
          setSemanticRecall(
            new RagSemanticRecall(ctx.db, cachingEmbedder, {
              topK: env.MEMORY_SEMANTIC_RECALL_TOP_K,
              minScore: env.MEMORY_SEMANTIC_RECALL_MIN_SCORE,
              excludeRecent: env.MEMORY_SEMANTIC_RECALL_EXCLUDE_RECENT,
            }),
          );
          console.log(
            `[bootstrap] D.3 semantic recall wired top_k=${env.MEMORY_SEMANTIC_RECALL_TOP_K} min_score=${env.MEMORY_SEMANTIC_RECALL_MIN_SCORE}`,
          );
        }
        if (env.MEMORY_CONDENSE_ENABLED) {
          setCondenseQueue(createCondenseQueue(ctx.redis));
          console.log(
            `[bootstrap] D.3 condense queue wired name=${env.MEMORY_CONDENSE_QUEUE_NAME}`,
          );
        }
      },
    },
    {
      name: "calendar-health",
      async execute() {
        const result = await fetch(`${getHarnessConfig().calendar.baseUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        }).catch((err) => {
          throw new Error(`Calendar health check failed: ${err}`);
        });
        console.log(`[bootstrap] Calendar service health: ${result.status} ${result.statusText}`);
      },
    },
    {
      name: "start-dev-ws",
      async execute() {
        if (!isDevModeEnabled()) {
          console.log("[bootstrap] dev ws server skipped (HARNESS_DEV_MODE not set)");
          return;
        }
        const env = getEnv();
        startDevWsServer(env.HARNESS_DEV_WS_PORT, env.HARNESS_DEV_WS_HOST);
        console.log(
          `[bootstrap] Dev playground ws server listening on ws://${env.HARNESS_DEV_WS_HOST}:${env.HARNESS_DEV_WS_PORT}`,
        );
      },
    },
    {
      name: "init-evals",
      async execute() {
        const env = getEnv();
        if (!env.EVALS_ENABLED && !env.EVALS_WORKER_ENABLED) {
          console.log("[bootstrap] evals subsystem disabled (EVALS_ENABLED=false)");
          return;
        }

        // Validate sampling policy at boot — fail fast on bad config.
        const policy = parseSamplingPolicy(env.EVALS_SAMPLING_POLICY);
        setSamplingPolicy(policy);

        const enabled = env.EVALS_SCORERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        setEnabledScorers(enabled);

        if (env.EVALS_ENABLED) {
          const queue = new EvalQueue(ctx.redis, env.EVALS_QUEUE_NAME);
          setEvalQueue(queue);
          console.log(
            `[bootstrap] Evals enabled: queue=${queue.name} policy=${policy.type} scorers=${enabled.join(",")}`,
          );
        }

        if (env.EVALS_WORKER_ENABLED) {
          const gateway = createLLMGateway({ default_model: env.EVALS_JUDGE_MODEL });
          const scorers = buildScorers(enabled, {
            gateway,
            judgeModel: env.EVALS_JUDGE_MODEL,
          });
          const evalLogger = createLogger({
            name: "eval-worker",
            level: getHarnessConfig().harness.logLevel,
          });
          const runner = new EvalRunner(scorers, evalLogger);
          const repo = new EvalResultsRepository(ctx.db);
          const worker = startEvalWorker({
            connection: ctx.redis,
            runner,
            repo,
            logger: evalLogger,
          });
          setEvalWorker(worker);
          console.log(
            `[bootstrap] Eval worker started: concurrency=${env.EVALS_WORKER_CONCURRENCY} scorers=${scorers.length}`,
          );
        }
      },
    },
    {
      name: "start-workflow-resume",
      async execute() {
        // Resume entrypoints are opt-in. ADR-012 explains why this is NOT a
        // public REST API. The HTTP server and Redis subscriber are wired
        // lazily by `execution-handler` (which has the toolExecutor + ctx
        // factory) — here we only validate env consistency.
        const env = getEnv();
        if (env.WORKFLOW_RESUME_ENABLED && !env.WORKFLOW_RESUME_SECRET) {
          throw new Error(
            "WORKFLOW_RESUME_ENABLED=true requires WORKFLOW_RESUME_SECRET (>=32 chars)",
          );
        }
        _workflowCleanupJob?.start();
        console.log(
          `[bootstrap] Workflow resume: enabled=${env.WORKFLOW_RESUME_ENABLED} via_redis=${env.WORKFLOW_RESUME_VIA_REDIS}`,
        );
      },
    },
    {
      name: "start-consumer",
      async execute() {
        await startConsumer({
          db: ctx.db,
          redis: ctx.redis,
          agentRegistry: AgentRegistry.getInstance(),
          toolRegistry: UnifiedToolRegistry.getInstance(),
          agentRouter: _agentRouter,
        });
      },
    },
  ];
}
