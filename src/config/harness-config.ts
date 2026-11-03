import { getEnv } from "./env.js";

export const getHarnessConfig = () => {
  const env = getEnv();
  return {
    db: { connectionString: env.DATABASE_URL },
    redis: { url: env.REDIS_URL },
    bevox: { callbackBaseUrl: env.BEVOX_CALLBACK_BASE_URL },
    calendar: { baseUrl: env.CALENDAR_SERVICE_URL },
    llm: {
      provider: env.DEFAULT_LLM_PROVIDER,
      model: env.DEFAULT_LLM_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    },
    harness: {
      logLevel: env.HARNESS_LOG_LEVEL,
      maxExecutionTimeMs: env.HARNESS_MAX_EXECUTION_TIME_MS,
      maxCostUsd: env.HARNESS_MAX_COST_USD, // J9 — default org-wide cost ceiling (USD)
      queueName: env.HARNESS_QUEUE_NAME,
      dispatchFailedRetentionS: env.HARNESS_DISPATCH_FAILED_RETENTION_S,
    },
    // Fase B §7 — Ross×Bertuzzi conflict tunables (harness-level defaults).
    // Each field maps to a specific conflict from §7; per-account sdr_profile
    // values take precedence via resolveQualificationFramework() in src/sdr/tunables.ts.
    sdr: {
      // Conflict: PACT (Ross sniff-test) vs PACT+Timing (Bertuzzi PACT2 for mature markets).
      // Default PACT; accounts override via sdr_profile.qualification_framework.
      qualificationFramework: env.SDR_QUALIFICATION_FRAMEWORK,
      // Conflict: Ross email-first referral-driven vs Bertuzzi voice/VM co-equal (2× data).
      // Weight multiplier applied to phone/VM touches relative to email (1 = equal weight).
      phoneVmWeight: env.SDR_PHONE_VM_WEIGHT,
      // Conflict: Ross 3 fixed roles (SDR/AE/AM) vs Bertuzzi +research role (conditional ≥2 triggers).
      // "3-role" = Ross strict; "4-role" = Bertuzzi research role enabled.
      roleGranularity: env.SDR_ROLE_GRANULARITY,
      // Conflict: Ross immediate response SLA vs Bertuzzi conditional fast-path by intent-score.
      // false = no global SLA; true = fast-path keyed on intent-score (Bertuzzi-aligned).
      speedToContactFastpath: env.SDR_SPEED_TO_CONTACT_FASTPATH,
    },
  };
};
