import type { Job, WorkerOptions } from "bullmq";
import { Worker } from "bullmq";
import pino from "pino";

import { getHarnessConfig } from "../config/harness-config.js";
import { updateStatus } from "../integration/bevox-callback.js";
import {
  recordDeadLetter,
  recordTransientFailure,
  type DeadLetterCategory,
} from "../observability/dead-letter-metrics.js";
import type { ExecutionContext } from "../runtime/execution-handler.js";
import { handleExecution, UnprocessablePayloadError } from "../runtime/execution-handler.js";
import { MutationTool } from "../tools/_shared/mutation-tool.js";
import type { ToolContext } from "../tools/_shared/mutation-tool.js";

const config = getHarnessConfig();
const logger = pino({ level: config.harness.logLevel, name: "bullmq-consumer" });

let activeWorker: Worker | null = null;

export async function startConsumer(ctx: ExecutionContext): Promise<Worker> {
  const { queueName, dispatchFailedRetentionS } = config.harness;

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const payload: unknown = job.data;
      logger.info({ jobId: job.id }, "Job received");

      // §4.11.3 — re-delivery é INVISÍVEL hoje (cost_ceiling re-entregue é
      // absorvido silenciosamente pela dedup key; sem DLQ — CLAUDE.md "v2").
      // Logar attemptsMade torna o retry-loop AUDITÁVEL p/ alerta. NÃO bounda
      // o loop (isso exige DLQ + attempts do producer — fora de escopo).
      if (job.attemptsMade > 0) {
        logger.warn(
          {
            event: "execution.redelivery",
            execution_id: (job.data as { execution_id?: string } | undefined)?.execution_id,
            attemptsMade: job.attemptsMade,
          },
          "BullMQ re-delivered execution (no DLQ / no retry cap — see §4.11.3)",
        );
      }

      try {
        await handleExecution(payload, ctx);
        logger.info({ jobId: job.id }, "Job completed");
      } catch (err) {
        // Poison NÃO precisa de tratamento especial aqui:
        // `UnprocessablePayloadError extends UnrecoverableError` (§4.1), então
        // o BullMQ NÃO re-tenta mesmo com o `attempts: 7` LIVE do produtor
        // (check `instanceof || err.name` em job.js:486). Sem `job.discard()`.
        logger.error(
          { jobId: job.id, poison: err instanceof UnprocessablePayloadError, err },
          "Job failed (attempt)",
        );
        throw err; // → failed set local; dead_letter authoritativo no failed listener
      }
    },
    {
      connection: { url: config.redis.url } as never,
      // Worker-level RETENTION apenas. `attempts`/`backoff` NÃO são
      // WorkerOptions (vivem em base-job-options; producer-side) — ver §1.
      // Setá-los aqui é silenciosamente ignorado. Retry vem do produtor (attempts:7 LIVE).
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: dispatchFailedRetentionS }, // retenção LOCAL (eviction lazy, não TTL exato)
      // Anti-stalled-storm: limita re-delivery por lock expirado (SIGKILL etc).
      maxStalledCount: 1,
    } as WorkerOptions,
  );

  worker.on("error", (err) => {
    logger.error({ err }, "BullMQ worker error");
  });

  // J3/DEBT-05: canal de observabilidade + sinal dead-letter AUTHORITATIVO.
  // Consistente com condense-worker.ts:64 / eval-worker.ts:71.
  //
  // A dead-letter authoritativa vive no BACKEND (status='dead_letter'). Este
  // listener é o ÚNICO ponto que a escreve — na tentativa FINAL do attempts:7
  // (transiente esgotado) ou em poison salvageável (§b). O `failed` set retido
  // é só retenção LOCAL / forense.
  //
  // Listener async intencional: o EventEmitter ignora o retorno, e a única
  // chamada awaited (updateStatus) já é `.catch()`-guardada — o listener nunca
  // pode quebrar. Suprime no-misused-promises sem mudar o timing (o `void`-IIFE
  // detacharia o corpo e quebraria a ordering esperada pelos testes do listener).
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  worker.on("failed", async (job, err) => {
    const poison = err instanceof UnprocessablePayloadError;
    // §8 open #11 (J8 ainda NÃO merged em `main`): classifica abort por NOME
    // (mesmo padrão `err.name ==` do BullMQ em job.js:486). Abort NUNCA vira
    // retry_exhausted e NUNCA escreve dead_letter — é terminal/esperado (J8).
    const aborted = err?.name === "ExecutionAbortError";

    // attempts:7 LIVE. attemptsMade conta tentativas já FEITAS; +1 = a atual.
    // `>= opts.attempts` ⇒ esta é a última.
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const exhausted = attemptsMade + 1 >= maxAttempts;

    // Classificação local. `transient_attempt` é uma falha NÃO-final (vai
    // re-tentar) — NÃO é dead-letter, então NÃO faz parte de `DeadLetterCategory`.
    // É contabilizado numa métrica SEPARADA (recordTransientFailure) abaixo.
    const deadLetterCategory: DeadLetterCategory | null = aborted
      ? "aborted"
      : poison
        ? "poison"
        : exhausted
          ? "retry_exhausted"
          : null;
    const category = deadLetterCategory ?? "transient_attempt";

    logger.error(
      {
        jobId: job?.id,
        attemptsMade,
        maxAttempts,
        failedReason: job?.failedReason ?? err?.message,
        poison,
        aborted,
        exhausted,
        category,
      },
      "Job moved to failed set (local retention)",
    );

    // §a — Sinal dead-letter AUTHORITATIVO ao backend. Dispara quando:
    //   (i) transiente esgotou todas as attempts:7 (exhausted && !poison), OU
    //   (ii) poison salvageável (§b — visibilidade no replay UI).
    // NUNCA para abort (§e / §8 open #11): abort é terminal e dono do J8.
    if (!aborted && (exhausted || poison)) {
      const salvage = poison ? (err as UnprocessablePayloadError) : undefined;
      const data = job?.data as { execution_id?: string; execution_token?: string } | undefined;
      const execId = salvage?.executionId ?? data?.execution_id;
      const execToken = salvage?.executionToken ?? data?.execution_token;
      if (execId && execToken) {
        // ADR-023: deriveIdempotencyKey agora exige `params` (mutation-stack
        // landed na integração). Para a chave de dead-letter — discriminador
        // por DESFECHO, não por conteúdo de mutação — passamos `{}` como params
        // (mesmo padrão do helper `completeKey` no execution-handler): a chave
        // fica `sha256(lineageId:step:dead-letter:{})`, determinística e
        // trajectory-independent, o intent original do J3.
        const idemKey = MutationTool.deriveIdempotencyKey(
          { execution_id: execId, organization_id: "", step_index: 0 } as ToolContext,
          "dead-letter",
          {},
        );
        // §a2 PRIMARY: updateStatus com meta. Seta status='dead_letter' + action.
        // NÃO usar sendComplete(strategy:'failed') — não acende a replay UI.
        // Promise.resolve(...) torna o .catch robusto mesmo se updateStatus
        // lançar síncrono ou retornar não-thenable (o listener NUNCA pode quebrar).
        await Promise.resolve(
          updateStatus(execId, execToken, "dead_letter", {
            action: "retry_exhausted",
            failedReason: job?.failedReason ?? err?.message,
            attemptsMade,
            idempotencyKey: idemKey,
          }),
        ).catch((cbErr) => {
          // Redis/backend down: a dead-letter authoritativa é HTTP (independente
          // do Redis), mas a entrega não é garantida — o cron `bevox.timeout.scan`
          // do backend reconcilia (§4.6b / §8 risk 7).
          logger.warn(
            { cbErr, jobId: job?.id },
            "Failed to write dead_letter status to backend (cron reconciliation backstop)",
          );
        });
      }
    }

    // §4.5/§e — sinais de SLO em superfícies DISTINTAS que o dashboard NÃO deve
    // conflar: as três categorias TERMINAIS vão para a métrica de dead-letter;
    // a flakiness per-attempt (não-final) vai para o contador transiente próprio.
    if (deadLetterCategory) {
      recordDeadLetter({ category: deadLetterCategory });
    } else {
      recordTransientFailure();
    }
  });

  activeWorker = worker;
  logger.info({ queue: queueName }, "BullMQ consumer started");
  return worker;
}

export async function stopConsumer(): Promise<void> {
  if (activeWorker) {
    logger.info("Stopping BullMQ consumer");
    await activeWorker.close();
    activeWorker = null;
  }
}

export function getActiveWorker(): Worker | null {
  return activeWorker;
}
