import { getHarnessConfig } from "../config/harness-config.js";
import { createLogger } from "../config/logger.js";

const config = getHarnessConfig();
const logger = createLogger({ name: "bevox-callback", level: config.harness.logLevel });

const BASE_URL = config.bevox.callbackBaseUrl;

/**
 * C10 — quando `idempotencyKey` é fornecido, injeta header
 * `Idempotency-Key` (ADR-023 / PRD §13.3). Backend de-duplica callbacks
 * `/complete` com mesma chave caso BullMQ reprocesse. `undefined` = sem
 * header (comportamento legado).
 */
async function post(
  path: string,
  token: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<void> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Execution-Token": token,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bevox callback ${path} failed: ${res.status} ${text}`);
  }
}

export interface TraceEntry {
  step: number;
  type: "thought" | "action" | "observation";
  content: string;
  timestamp: string;
}

export interface StreamChunk {
  chunk: string;
  index: number;
}

/**
 * Shape do callback `/complete` aceito pelo backend
 * (`CompleteCallbackSchema` em `bevox-backend/src/integration/harness-callbacks.schema.ts`).
 * Os 4 campos são **obrigatórios** — ausência → HTTP 400. Fonte canônica:
 * PRD §10.4 + ADR-006.
 *
 * Histórico: campo originalmente chamado `response`; renomeado para
 * `response_text` em 2026-06-02 após auditoria CRÍT #2 detectar que o
 * backend rejeitava (`response_text` é o nome obrigatório no schema Zod
 * desde Marco-1).
 */
export interface CompletePayload {
  response_text: string;
  sentiment: string;
  strategy: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  proposals?: unknown[];
}

export interface BuildCompleteOptions {
  responseText: string;
  sentiment?: string;
  strategy?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  proposals?: unknown[];
}

/**
 * Helper canônico que SEMPRE preenche os 4 campos obrigatórios com
 * defaults seguros. Use em vez de construir o payload à mão em cada
 * call site (auditoria CRÍT #3: havia 6 sites omitindo `usage` →
 * HTTP 400). Defaults:
 * - `sentiment: "neutral"` quando o pipeline não computou um
 * - `strategy: "direct"` quando o engine não declarou um
 * - `usage: {0, 0}` quando o tracker não está ligado (TODO C13)
 */
export function buildCompletePayload(opts: BuildCompleteOptions): CompletePayload {
  return {
    response_text: opts.responseText,
    sentiment: opts.sentiment ?? "neutral",
    strategy: opts.strategy ?? "direct",
    usage: opts.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    ...(opts.proposals && opts.proposals.length > 0 ? { proposals: opts.proposals } : {}),
  };
}

export async function sendTrace(
  executionId: string,
  token: string,
  trace: TraceEntry,
): Promise<void> {
  await post(`/api/v1/executions/${executionId}/traces`, token, { traces: [trace] });
  logger.debug({ executionId }, "Sent trace");
}

export async function sendStream(
  executionId: string,
  token: string,
  chunk: string,
  index: number,
): Promise<void> {
  await post(`/api/v1/executions/${executionId}/stream`, token, { chunk, index });
}

/**
 * §a2 — sinal de status ao backend. O `meta` opcional carrega o contexto do
 * dead-letter authoritativo (`status='dead_letter'`, `action='retry_exhausted'`)
 * escrito pelo `worker.on("failed")` na tentativa final do attempts:7. O
 * `idempotencyKey` (ADR-023) vira header via `post` (NÃO entra no body); o
 * resto do `meta` vai no body junto com `status`.
 *
 * Retrocompat: `meta` é opcional → as chamadas existentes
 * `updateStatus(id, token, status)` (ex. "running") seguem com body `{ status }`.
 */
export interface StatusMeta {
  action?: "retry_exhausted";
  failedReason?: string;
  attemptsMade?: number;
  idempotencyKey?: string; // ADR-023 — vira header `Idempotency-Key`, não body
}

export async function updateStatus(
  executionId: string,
  token: string,
  status: string,
  meta?: StatusMeta,
): Promise<void> {
  const { idempotencyKey, ...body } = meta ?? {};
  await post(
    `/api/v1/executions/${executionId}/status`,
    token,
    { status, ...body },
    idempotencyKey,
  );
  logger.debug({ executionId, status, action: meta?.action }, "Sent status update");
}

export async function sendComplete(
  executionId: string,
  token: string,
  payload: CompletePayload,
  idempotencyKey?: string,
): Promise<void> {
  await post(`/api/v1/executions/${executionId}/complete`, token, payload, idempotencyKey);
  logger.info({ executionId }, "Sent completion callback");
}
