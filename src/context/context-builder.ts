import { estimateTokens } from "./tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer, BuiltContext } from "./types.js";

interface ContextBuilderOptions {
  globalMaxTokens?: number; // default 8000 (overridden by agentConfig.maxContextTokens)
  /** Per-layer timeout (ms) for fail-open. Default 800. */
  layerTimeoutMs?: number;
}

/**
 * Heading used when a layer fails/times out: we still need a `section`
 * for the empty fallback block, but `ContextLayer` (types.ts) does not
 * carry one. Map the well-known layer `name` to its real heading so the
 * empty block is byte-compatible with the layer's own output (m2).
 */
const LAYER_HEADINGS: Record<string, string> = {
  "base-config": "## Configuracao base",
  rules: "## Regras de encaminhamento",
  calendar: "## Agenda",
  memory: "## Informacoes do contato",
  history: "## Historico da conversa",
};

function headingFor(layer: ContextLayer): string {
  return LAYER_HEADINGS[layer.name] ?? `## ${layer.name}`;
}

const EXPECTED_FAILURE_PATTERNS = [
  /timeout/i,
  /relation .* does not exist/i,
  /column .* does not exist/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
];

function isExpectedFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return EXPECTED_FAILURE_PATTERNS.some((re) => re.test(msg));
}

function emptyBlock(layer: ContextLayer): ContextBlock {
  return {
    section: headingFor(layer),
    content: "",
    tokenEstimate: 0,
    priority: layer.priority,
    compressible: layer.compressible,
  };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`layer timeout after ${ms}ms`)), ms);
  });
}

export class ContextBuilder {
  private readonly layers: ContextLayer[];
  private readonly globalMaxTokens: number;
  private readonly layerTimeoutMs: number;

  constructor(layers: ContextLayer[], options: ContextBuilderOptions = {}) {
    this.layers = [...layers].sort((a, b) => a.priority - b.priority);
    this.globalMaxTokens = options.globalMaxTokens ?? 8000;
    this.layerTimeoutMs = options.layerTimeoutMs ?? 800;
  }

  async build(input: ContextInput): Promise<BuiltContext> {
    // Fail-open: a single rejecting/timing-out layer must NOT abort the build.
    const settled = await Promise.allSettled(
      this.layers.map((layer) => this.buildWithTimeout(layer, input)),
    );

    const blocks: ContextBlock[] = [];
    const layersFailed: string[] = [];
    const layersFailedUnexpected: string[] = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        blocks.push(res.value);
      } else {
        layersFailed.push(this.layers[i].name);
        if (!isExpectedFailure(res.reason)) {
          layersFailedUnexpected.push(this.layers[i].name);
        }
        blocks.push(emptyBlock(this.layers[i]));
      }
    });

    const limit = input.agentConfig.maxContextTokens ?? this.globalMaxTokens;
    const totalTokens = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);

    if (totalTokens <= limit) {
      return this.assemble(blocks, false, layersFailed, layersFailedUnexpected);
    }

    const compressed = this.compress(blocks, limit);
    return this.assemble(compressed, true, layersFailed, layersFailedUnexpected);
  }

  private async buildWithTimeout(
    layer: ContextLayer,
    input: ContextInput,
  ): Promise<ContextBlock> {
    return Promise.race([layer.build(input), timeout(this.layerTimeoutMs)]);
  }

  private compress(blocks: ContextBlock[], limit: number): ContextBlock[] {
    // Work on a copy; compress from lowest priority (highest number) first
    const result = blocks.map((b) => ({ ...b }));

    for (let i = result.length - 1; i >= 0; i--) {
      const current = result.reduce((sum, b) => sum + b.tokenEstimate, 0);
      if (current <= limit) break;

      const block = result[i];
      if (!block.compressible) continue;

      const nonCompressibleTokens = result
        .filter((b) => !b.compressible)
        .reduce((sum, b) => sum + b.tokenEstimate, 0);
      const compressibleBudget = limit - nonCompressibleTokens;
      const compressibleTotal = result
        .filter((b) => b.compressible)
        .reduce((sum, b) => sum + b.tokenEstimate, 0);

      if (compressibleTotal <= compressibleBudget) break;

      const ratio = compressibleBudget / compressibleTotal;
      const lines = block.content.split("\n");
      const keepLines = Math.max(3, Math.floor(lines.length * ratio));
      block.content = lines.slice(0, keepLines).join("\n");
      block.tokenEstimate = estimateTokens(block.section + "\n" + block.content);
    }

    return result;
  }

  private assemble(
    blocks: ContextBlock[],
    compressed: boolean,
    layersFailed: string[],
    layersFailedUnexpected: string[],
  ): BuiltContext {
    const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
    const systemPrompt = sorted.map((b) => `${b.section}\n${b.content}`).join("\n\n");
    return {
      systemPrompt,
      totalTokens: sorted.reduce((sum, b) => sum + b.tokenEstimate, 0),
      layersUsed: sorted.map((b) => b.section),
      compressed,
      blocks: sorted,
      layersFailed,
      layersFailedUnexpected,
    };
  }
}
