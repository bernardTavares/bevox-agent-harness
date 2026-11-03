import { createLogger } from "../config/logger.js";

const logger = createLogger({ name: "dead-letter-metrics", level: "error" });

/**
 * §4.5/§e — sinais de SLO para o dispatch do worker.
 *
 * DUAS superfícies de métrica DISTINTAS, deliberadamente NÃO conflada uma na
 * outra — categorias terminais (dead-letter) vs. flakiness per-attempt:
 *
 * `harness_dispatch_dead_letter_total` — SÓ as TRÊS categorias TERMINAIS:
 *  - `poison`           — UnrecoverableError, morre na tentativa 1. Esperado,
 *                         baixo volume; spike = regressão de contrato do produtor.
 *  - `retry_exhausted`  — transiente que esgotou todas as attempts:7. SINAL DE
 *                         INCIDENTE. É a categoria que escreve status='dead_letter'.
 *  - `aborted`          — abort terminal de wall-clock/cost (J8). ESPERADO, NÃO
 *                         alerta; alimentado pelo path de abort, NUNCA por este
 *                         listener (§e).
 *
 * `harness_dispatch_transient_failure_total` — contador SEPARADO:
 *  - falha transiente NÃO-final (vai re-tentar). Taxa de flakiness, NÃO é
 *    dead-letter — bundlá-la sob a métrica de dead-letter inflava/confundia o
 *    dashboard de SLO. Vive numa métrica própria.
 *
 * Para o pilot: sem dependência de métricas nova — incrementa contador + loga
 * level 50. O export OTEL fica para follow-up (gated por OTEL_ENABLED); os
 * contratos `recordDeadLetter`/`recordTransientFailure` permanecem estáveis.
 */
export type DeadLetterCategory = "poison" | "retry_exhausted" | "aborted";

type DeadLetterCounts = Record<DeadLetterCategory, number>;

const counts: DeadLetterCounts = {
  poison: 0,
  retry_exhausted: 0,
  aborted: 0,
};

/**
 * Contador SEPARADO de flakiness per-attempt (falha transiente não-final). NÃO
 * é dead-letter e NUNCA aparece na superfície de SLO `harness_dispatch_dead_letter_total`.
 */
let transientFailureCount = 0;

export function recordDeadLetter(opts: { category: DeadLetterCategory }): void {
  counts[opts.category] += 1;
  logger.error(
    {
      metric: "harness_dispatch_dead_letter_total",
      category: opts.category,
      counts: { ...counts },
    },
    "dispatch dead-letter recorded",
  );
}

export function getDeadLetterCounts(): DeadLetterCounts {
  return { ...counts };
}

export function resetDeadLetterCounts(): void {
  counts.poison = 0;
  counts.retry_exhausted = 0;
  counts.aborted = 0;
}

export function recordTransientFailure(): void {
  transientFailureCount += 1;
  logger.error(
    {
      metric: "harness_dispatch_transient_failure_total",
      count: transientFailureCount,
    },
    "dispatch transient (non-final) failure recorded",
  );
}

export function getTransientFailureCount(): number {
  return transientFailureCount;
}

export function resetTransientFailureCount(): void {
  transientFailureCount = 0;
}
