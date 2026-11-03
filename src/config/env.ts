import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string(),
    BEVOX_CALLBACK_BASE_URL: z.string().url(),
    BEVOX_DB_URL: z.string().url().optional(),
    CALENDAR_SERVICE_URL: z.string().url(),
    OPENAI_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    // Plural variants — comma-separated lists, consumed by CredentialPool
    OPENAI_API_KEYS: z.string().optional(),
    GEMINI_API_KEYS: z.string().optional(),
    ANTHROPIC_API_KEYS: z.string().optional(),
    DEFAULT_LLM_PROVIDER: z.enum(["openai", "gemini", "anthropic"]).default("openai"),
    DEFAULT_LLM_MODEL: z.string().default("gpt-4o-mini"),
    HARNESS_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    HARNESS_MAX_EXECUTION_TIME_MS: z.coerce.number().default(90000),
    // J9 — teto de custo default (USD) por execução. 0 = sem teto (legacy /
    // retrocompat). Override por-execução via payload.max_cost_usd tem
    // precedência. Resolvido em centavos no handler (Task 7).
    HARNESS_MAX_COST_USD: z.coerce.number().min(0).default(0),
    HARNESS_QUEUE_NAME: z.string().default("bevox.execution.dispatch"),
    // J3/DEBT-05 (§4.4): janela de retenção LOCAL do `failed` set
    // (removeOnFail.age, segundos). NÃO é TTL determinístico (eviction lazy) e
    // NÃO é a dead-letter authoritativa (essa é status='dead_letter' no backend).
    // `attempts`/`backoff` NÃO entram aqui — são producer-side e ignorados num
    // Worker (§1/§4.3). Default 24h.
    HARNESS_DISPATCH_FAILED_RETENTION_S: z.coerce.number().int().positive().default(86_400),
    // Phase 8 — pluggable skills
    NODE_ENV: z.string().default("development"),
    SKILLS_PATH: z.string().optional(),
    ALLOW_EXTERNAL_SKILLS: z.coerce.boolean().default(false),
    SKILLS_DISABLED: z.string().default(""),
    // Phase 3 — rate limit defaults (per organizationId:toolName, sliding window).
    RATE_LIMIT_SEND_MESSAGE_PER_MINUTE: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_CALENDAR_MUTATIONS_PER_MINUTE: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_REQUEST_HUMAN_PER_HOUR: z.coerce.number().int().positive().default(5),
    // Phase 4 — OpenTelemetry observability
    OTEL_ENABLED: z.coerce.boolean().default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().default("bevox-agent-harness"),
    OTEL_SERVICE_VERSION: z.string().default("0.0.0"),
    // Phase 5 — LLM robustness controls
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().default(30_000),
    LLM_RETRY_MAX_ATTEMPTS: z.coerce.number().default(3),
    LLM_RETRY_BASE_DELAY_MS: z.coerce.number().default(200),
    LLM_RETRY_MAX_DELAY_MS: z.coerce.number().default(5_000),
    LLM_CIRCUIT_ERROR_THRESHOLD_PCT: z.coerce.number().default(50),
    LLM_CIRCUIT_RESET_MS: z.coerce.number().default(30_000),
    LLM_CIRCUIT_MIN_SAMPLES: z.coerce.number().default(5),
    LLM_CIRCUIT_ROLLING_WINDOW_MS: z.coerce.number().default(60_000),
    LLM_CREDENTIAL_COOLDOWN_MS: z.coerce.number().default(30_000),
    // Sprint A.1 — LLM Recorder/Replay
    LLM_RECORDER_MODE: z.enum(["record", "replay", "passthrough"]).default("passthrough"),
    LLM_RECORDER_CASSETTE_DIR: z.string().default("tests/fixtures/cassettes"),
    LLM_RECORDER_CASSETTE_NAME: z.string().optional(),
    // If true (CI default), record/replay modes REQUIRE an explicit cassette
    // name. Prevents accidental writes to a default cassette in shared
    // environments. Note: `z.coerce.boolean()` treats any non-empty string as
    // true, so we explicitly map the literal string "false" / "0" to false.
    LLM_RECORDER_REQUIRE_NAME: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return !(v === "false" || v === "0");
      }),
    // Sprint D.1 — Dev Playground
    HARNESS_DEV_MODE: z.coerce.boolean().default(false),
    HARNESS_DEV_WS_PORT: z.coerce.number().int().min(1024).max(65535).default(4400),
    HARNESS_DEV_WS_HOST: z.string().default("127.0.0.1"),
    HARNESS_DEV_PROMPT_MAX_BYTES: z.coerce.number().int().positive().default(8192),
    HARNESS_DEV_WS_BACKPRESSURE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    // Sprint B.1 — MCP server (optional; only consumed by `bevox-mcp` binary)
    MCP_TRANSPORT: z.enum(["stdio", "sse"]).optional(),
    MCP_EXPOSED_SKILLS: z.string().optional(),
    MCP_DENIED_SKILLS: z.string().optional(),
    MCP_SERVER_TOKEN: z.string().min(32).optional(),
    MCP_SSE_HOST: z.string().default("127.0.0.1"),
    MCP_SSE_PORT: z.coerce.number().int().min(1).max(65535).default(7071),
    BEVOX_DEFAULT_ORGANIZATION_ID: z.string().uuid().optional(),
    // Sprint A.2 — Evals / Scorers
    EVALS_ENABLED: z.coerce.boolean().default(false),
    EVALS_QUEUE_NAME: z.string().default("execution.evals"),
    EVALS_WORKER_ENABLED: z.coerce.boolean().default(false),
    EVALS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
    EVALS_JUDGE_MODEL: z.string().default("gpt-4o-mini"),
    /**
     * JSON-encoded SamplingPolicy. Validated at boot via samplingPolicySchema;
     * invalid — fail fast. Default is "never" so EVALS_ENABLED=true alone has
     * zero behaviour change.
     */
    EVALS_SAMPLING_POLICY: z.string().default('{"type":"never"}'),
    /** Comma-separated list of scorer names to run when sampling triggers. */
    EVALS_SCORERS: z.string().default("relevancy,no-pii,answer-length"),
    // Sprint C.1 — Workflow Engine
    WORKFLOW_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    WORKFLOW_SUSPEND_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
    WORKFLOW_CLEANUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60 * 1000),
    WORKFLOW_RESUME_HOST: z.string().default("127.0.0.1"),
    WORKFLOW_RESUME_PORT: z.coerce.number().int().min(1).max(65535).default(4500),
    WORKFLOW_RESUME_SECRET: z.string().min(32).optional(),
    WORKFLOW_RESUME_ENABLED: z.coerce.boolean().default(false),
    WORKFLOW_RESUME_VIA_REDIS: z.coerce.boolean().default(false),
    // Sprint B.2 — MCP client (consume external MCP servers as skills)
    // Note: use enum/transform instead of z.coerce.boolean() — the latter
    // treats the literal string "false" as truthy.
    MCP_CLIENT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    MCP_SERVERS_CONFIG_PATH: z.string().optional(),
    MCP_CLIENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
    MCP_REQUIRE_ALL: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Sprint C.2 — Streaming Responses
    STREAM_ENABLED: z.coerce.boolean().default(false),
    STREAM_FLUSH_MS: z.coerce.number().int().min(50).max(2000).default(100),
    STREAM_FLUSH_TOKENS: z.coerce.number().int().min(1).max(500).default(50),
    STREAM_CALLBACK_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
    // Sprint D.2 — RAG (pgvector)
    RAG_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    RAG_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
    RAG_EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
    RAG_TOP_K_DEFAULT: z.coerce.number().int().positive().default(5),
    RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
    // Sprint D.3 — Semantic + Observational Memory
    // All flags default OFF: D.3 adds capability without changing behaviour
    // unless explicitly enabled.
    MEMORY_SEMANTIC_RECALL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    MEMORY_SEMANTIC_RECALL_TOP_K: z.coerce.number().int().positive().default(5),
    MEMORY_SEMANTIC_RECALL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.6),
    MEMORY_SEMANTIC_RECALL_EXCLUDE_RECENT: z.coerce.number().int().min(0).default(10),
    MEMORY_INDEXER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    MEMORY_CONDENSE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    MEMORY_CONDENSE_THRESHOLD_MESSAGES: z.coerce.number().int().positive().default(50),
    MEMORY_CONDENSE_THRESHOLD_TOKENS: z.coerce.number().int().positive().default(8000),
    MEMORY_CONDENSE_THRESHOLD_DAYS: z.coerce.number().int().positive().default(7),
    MEMORY_CONDENSE_QUEUE_NAME: z.string().default("harness.memory.condense"),
    MEMORY_CONDENSE_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
    // Fase B §7 — SDR tunables: Ross×Bertuzzi conflict resolutions (harness-level defaults)
    // Per-account override via sdr_profile.qualification_framework; resolver in src/sdr/tunables.ts
    SDR_QUALIFICATION_FRAMEWORK: z.enum(["PACT", "PACT2"]).default("PACT"),
    SDR_PHONE_VM_WEIGHT: z.coerce.number().default(1),
    SDR_ROLE_GRANULARITY: z.enum(["3-role", "4-role"]).default("3-role"),
    SDR_SPEED_TO_CONTACT_FASTPATH: z.coerce.boolean().default(false),
    // CTX-01 — ContextBuilder runtime instantiation (issue #39).
    // Default OFF on initial merge; flipped true in Phase 4 after regression.
    // Uses the .enum().transform() pattern (NOT z.coerce.boolean(), which
    // treats the literal string "false" as truthy).
    CONTEXT_BUILDER_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Per-layer timeout (ms) for ContextBuilder fail-open. */
    CONTEXT_BUILDER_LAYER_TIMEOUT_MS: z.coerce.number().int().positive().default(800),
  })
  .refine((env) => env.MCP_TRANSPORT !== "sse" || (env.MCP_SERVER_TOKEN?.length ?? 0) >= 32, {
    message: "MCP_SERVER_TOKEN (min 32 chars) is required when MCP_TRANSPORT=sse",
  })
  .refine((env) => !env.MCP_CLIENT_ENABLED || !!env.MCP_SERVERS_CONFIG_PATH, {
    message: "MCP_SERVERS_CONFIG_PATH required when MCP_CLIENT_ENABLED=true",
  });

export type HarnessEnv = z.infer<typeof envSchema>;

let cached: HarnessEnv | null = null;

export const getEnv = (): HarnessEnv => {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.format());
    process.exit(1);
  }
  cached = result.data;
  return cached;
};

/** Test-only: clear the cache so tests can mutate env after import. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
