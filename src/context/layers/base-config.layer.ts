import { estimateTokens } from "../tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer } from "../types.js";

export class BaseConfigLayer implements ContextLayer {
  readonly name = "base-config";
  readonly priority = 10;
  readonly compressible = false;

  async build(input: ContextInput): Promise<ContextBlock> {
    const content = input.agentConfig.systemPrompt ?? "";
    return {
      section: "## Configuracao base",
      content,
      tokenEstimate: estimateTokens("## Configuracao base\n" + content),
      priority: this.priority,
      compressible: this.compressible,
    };
  }
}
