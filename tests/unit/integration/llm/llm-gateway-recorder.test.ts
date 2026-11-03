/**
 * Tests for the Sprint A.1 recorder/replayer wiring in createLLMGateway.
 *
 * These tests manipulate process.env (LLM_RECORDER_*) to flip the factory's
 * three modes and verify the resulting gateway instance is of the expected
 * type. Lower-level recorder/replayer/store behavior is covered in their own
 * dedicated test files.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

const stubPool = new CredentialPool();
stubPool.register("openai", ["test-openai-key"]);

vi.mock("../../../../src/integration/llm/credential-pool", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/integration/llm/credential-pool")
  >("../../../../src/integration/llm/credential-pool");
  return { ...actual, getCredentialPool: () => stubPool };
});

const ENV_KEYS = [
  "LLM_RECORDER_MODE",
  "LLM_RECORDER_CASSETTE_NAME",
  "LLM_RECORDER_CASSETTE_DIR",
  "LLM_RECORDER_REQUIRE_NAME",
] as const;

describe("createLLMGateway — recorder wiring", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Reset module-cached env + singleton store between tests.
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns composed gateway (no recorder) when mode = passthrough (default)", async () => {
    delete process.env.LLM_RECORDER_MODE;
    const { createLLMGateway } = await import("../../../../src/integration/llm-gateway.js");
    const { RetryDecorator } = await import(
      "../../../../src/integration/llm/retry-decorator.js"
    );
    const { DevEmitterLLM } = await import(
      "../../../../src/integration/llm/dev-emitter-decorator.js"
    );
    const gw = createLLMGateway({ default_model: "openai/gpt-4o-mini" });
    // Sprint D.1 wraps outermost with DevEmitterLLM; unwrap to verify retry layer.
    expect(gw).toBeInstanceOf(DevEmitterLLM);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gw as any).inner).toBeInstanceOf(RetryDecorator);
  });

  it("throws when mode = record without cassette name (REQUIRE_NAME default)", async () => {
    process.env.LLM_RECORDER_MODE = "record";
    delete process.env.LLM_RECORDER_CASSETTE_NAME;
    const { createLLMGateway } = await import("../../../../src/integration/llm-gateway.js");
    expect(() => createLLMGateway({ default_model: "openai/gpt-4o-mini" })).toThrow(
      /requires LLM_RECORDER_CASSETTE_NAME/,
    );
  });

  it("returns LLMRecorder when mode = record with a cassette name", async () => {
    process.env.LLM_RECORDER_MODE = "record";
    process.env.LLM_RECORDER_CASSETTE_NAME = "smoke/test";
    const { createLLMGateway } = await import("../../../../src/integration/llm-gateway.js");
    const { LLMRecorder } = await import("../../../../src/integration/llm/recorder.js");
    const { DevEmitterLLM } = await import(
      "../../../../src/integration/llm/dev-emitter-decorator.js"
    );
    const gw = createLLMGateway({ default_model: "openai/gpt-4o-mini" });
    expect(gw).toBeInstanceOf(DevEmitterLLM);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gw as any).inner).toBeInstanceOf(LLMRecorder);
  });

  it("returns LLMReplayer when mode = replay", async () => {
    process.env.LLM_RECORDER_MODE = "replay";
    process.env.LLM_RECORDER_CASSETTE_NAME = "smoke/test";
    const { createLLMGateway } = await import("../../../../src/integration/llm-gateway.js");
    const { LLMReplayer } = await import("../../../../src/integration/llm/replay.js");
    const { DevEmitterLLM } = await import(
      "../../../../src/integration/llm/dev-emitter-decorator.js"
    );
    const gw = createLLMGateway({ default_model: "openai/gpt-4o-mini" });
    expect(gw).toBeInstanceOf(DevEmitterLLM);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gw as any).inner).toBeInstanceOf(LLMReplayer);
  });

  it("allows record without a name when REQUIRE_NAME=false", async () => {
    process.env.LLM_RECORDER_MODE = "record";
    process.env.LLM_RECORDER_REQUIRE_NAME = "false";
    delete process.env.LLM_RECORDER_CASSETTE_NAME;
    const { createLLMGateway } = await import("../../../../src/integration/llm-gateway.js");
    const { LLMRecorder } = await import("../../../../src/integration/llm/recorder.js");
    const { DevEmitterLLM } = await import(
      "../../../../src/integration/llm/dev-emitter-decorator.js"
    );
    const gw = createLLMGateway({ default_model: "openai/gpt-4o-mini" });
    expect(gw).toBeInstanceOf(DevEmitterLLM);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gw as any).inner).toBeInstanceOf(LLMRecorder);
  });
});
