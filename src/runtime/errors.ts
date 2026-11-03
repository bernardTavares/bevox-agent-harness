/**
 * J8/J9 — erros tipados de bounding de execução (wall-clock + cost ceiling).
 *
 * Lançados pelo `execution-handler` quando uma execução cruza o deadline
 * absoluto de wall-clock (via `runWithTimeout` → `phase_timeout`) ou o teto de
 * custo (`cost_ceiling`). Caem no MESMO `catch` boundary que trata falhas, MAS
 * são DESFECHOS TERMINAIS: o boundary emite o `/complete` (`aborted_timeout` /
 * `aborted_cost`), RETÉM a dedup key e dá ACK no job (RETURN, sem rethrow) —
 * então o BullMQ NÃO re-tenta uma execução condenada a re-abortar. Só erros
 * genuinamente transientes (não-abort) são re-lançados para o retry do
 * producer. Ficam num módulo dedicado para que o handler e o consumer possam
 * importar o tipo sem ciclo através do handler de ~1700 linhas.
 */

export type AbortReason =
  | "wall_clock_timeout"
  | "cost_ceiling"
  | "phase_timeout"
  // a-reasoning-03 (R03) — plano ReWOO cíclico é determinístico → abort
  // terminal non-retryable. Mapeia para `aborted_timeout` no boundary (mesmo
  // desfecho de qualquer abort != cost_ceiling — re-rodar só re-gera o ciclo).
  | "invalid_plan";

export class ExecutionAbortError extends Error {
  constructor(
    /** Causa do abort — vira `execution.abort.reason` no span + log estruturado. */
    readonly reason: AbortReason,
    message: string,
    /**
     * Marca o abort como terminal-determinístico. TODO abort hoje é tratado
     * como TERMINAL pelo boundary (ACK + /complete, sem rethrow), independente
     * deste valor — o campo permanece como documentação semântica explícita de
     * que aquele caminho NÃO é re-tentável. `cost_ceiling` e `phase_timeout`
     * são construídos com `false` (determinísticos: re-rodar só re-aborta).
     * Default `true` por retrocompat de assinatura.
     */
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "ExecutionAbortError";
  }
}
