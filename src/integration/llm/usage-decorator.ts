/**
 * UsageDecorator — intercepta cada `LLMGateway.complete()` para reportar
 * tokens reais (`input_tokens`, `output_tokens`) ao caller via callback.
 *
 * C13 (auditoria 2026-06-02): antes, o handler enviava `usage: {0, 0}` no
 * `/complete` final porque `totalTokens = 0` era hardcoded; o
 * `UsageTracker` existia mas nunca era instanciado. Agora a decoração
 * intercepta cada resposta do LLM, soma ao acumulador injetado, e o
 * handler envia o total real no callback. Cobre PRD §16.1 + §12.12
 * (custo por execução observável).
 *
 * Posição na chain: depende do que se quer medir. Hoje:
 *   - **Fora do retry/circuit-breaker**: o callback recebe a *resposta
 *     final* (após retries internos), espelhando o que o caller vê. Não
 *     conta tokens "desperdiçados" em retries do nosso lado.
 *   - **Streaming não suportado neste primeiro fix**: completeStream
 *     passa-through sem somar. (Próximo PR — streaming exige flushing
 *     do delta de tokens só no final do stream.)
 *
 * `onUsage` é defensivo: se lançar, engole. Métrica é best-effort —
 * nunca quebra o caminho do LLM.
 */

import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway.js";
import type { CompleteStreamOptions, StreamChunk } from "./streaming/types.js";

export interface UsageCallback {
  (usage: LLMResponse["usage"], meta: { model: string; provider: string; latencyMs: number }): void;
}

export class UsageDecorator implements LLMGateway {
  constructor(
    private readonly inner: LLMGateway,
    private readonly onUsage: UsageCallback,
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.inner.complete(options);
    // Best-effort — qualquer throw no callback é engolido.
    try {
      this.onUsage(response.usage, {
        model: response.model,
        provider: response.provider,
        latencyMs: response.latency_ms,
      });
    } catch {
      // intencionalmente silencioso — tracker não pode quebrar a chamada LLM
    }
    return response;
  }

  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    if (!this.inner.completeStream) {
      throw new Error("UsageDecorator: streaming não suportado pelo adapter envolvido");
    }
    // V1 do C13: streaming passa-through sem somar tokens. PRD §16.1
    // streaming usage tracking é follow-up — exige consumir o stream
    // até o final para extrair `usage` (alguns providers só mandam no
    // último chunk).
    return this.inner.completeStream(options);
  }
}
