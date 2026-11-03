/**
 * Vitest helper for cassette-backed tests.
 *
 * Usage:
 *
 *   import { useCassette } from "../helpers/cassette-fixture";
 *
 *   describe("ReAct engine", () => {
 *     const cassette = useCassette("reasoning/react-happy-path");
 *     it("completes a 3-step plan", async () => {
 *       const engine = new ReActEngine(cassette.gateway());
 *       ...
 *     });
 *   });
 *
 * Modes (driven by LLM_RECORDER_MODE env var):
 *   - `replay` (default for tests): returns an LLMReplayer; misses throw.
 *   - `record`: NOT supported via this helper — record requires the caller
 *     to inject an explicit upstream gateway. Use `new LLMRecorder(...)`
 *     directly from the test or run the worker with
 *     `LLM_RECORDER_MODE=record LLM_RECORDER_CASSETTE_NAME=…`.
 *
 * To regenerate a cassette in-place:
 *   LLM_RECORDER_MODE=record LLM_RECORDER_CASSETTE_NAME=path/name \\
 *     npm run test:unit -- path/to/test.test.ts
 */
import type { LLMGateway } from "../../src/integration/llm-gateway.js";
import { CassetteStore } from "../../src/integration/llm/cassette-store.js";
import { LLMReplayer } from "../../src/integration/llm/replay.js";

const DEFAULT_DIR = "tests/fixtures/cassettes";

export interface CassetteHandle {
  /** Build an `LLMGateway` bound to this cassette in the current mode. */
  gateway(): LLMGateway;
  readonly name: string;
  readonly model: string;
}

export function useCassette(name: string, model = "gpt-4o-mini"): CassetteHandle {
  const mode = process.env.LLM_RECORDER_MODE ?? "replay";
  const dir = process.env.LLM_RECORDER_CASSETTE_DIR ?? DEFAULT_DIR;
  const store = new CassetteStore(dir);

  return {
    name,
    model,
    gateway(): LLMGateway {
      if (mode === "replay") {
        return new LLMReplayer(store, name, model);
      }
      if (mode === "record") {
        throw new Error(
          "useCassette() does not support 'record' mode — instantiate LLMRecorder directly " +
            "with an explicit upstream gateway.",
        );
      }
      throw new Error(`Unsupported LLM_RECORDER_MODE for useCassette: ${mode}`);
    },
  };
}
