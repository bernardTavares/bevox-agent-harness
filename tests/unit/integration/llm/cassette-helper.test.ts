/**
 * Smoke tests for the `useCassette` helper.
 *
 * Uses the reference fixture `tests/fixtures/cassettes/example/hello-world.cassette.json`
 * to validate that:
 *   1. The helper produces a working LLMReplayer in default (replay) mode.
 *   2. Misses surface as CassetteMissError.
 *   3. Switching to record mode without explicit upstream throws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteMissError } from "../../../../src/integration/llm/errors.js";
import { useCassette } from "../../../helpers/cassette-fixture.js";

describe("useCassette helper", () => {
  const savedMode = process.env.LLM_RECORDER_MODE;
  const savedDir = process.env.LLM_RECORDER_CASSETTE_DIR;

  beforeEach(() => {
    delete process.env.LLM_RECORDER_MODE;
    process.env.LLM_RECORDER_CASSETTE_DIR = "tests/fixtures/cassettes";
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.LLM_RECORDER_MODE;
    else process.env.LLM_RECORDER_MODE = savedMode;
    if (savedDir === undefined) delete process.env.LLM_RECORDER_CASSETTE_DIR;
    else process.env.LLM_RECORDER_CASSETTE_DIR = savedDir;
  });

  it("returns a replayer gateway in default mode", () => {
    const c = useCassette("example/hello-world");
    expect(c.gateway()).toBeDefined();
    expect(c.name).toBe("example/hello-world");
    expect(c.model).toBe("gpt-4o-mini");
  });

  it("rejects unknown requests with CassetteMissError", async () => {
    const c = useCassette("example/hello-world");
    const gw = c.gateway();
    await expect(
      gw.complete({ messages: [{ role: "user", content: "totally-different" }] }),
    ).rejects.toBeInstanceOf(CassetteMissError);
  });

  it("throws when invoked in record mode (record needs explicit upstream)", () => {
    process.env.LLM_RECORDER_MODE = "record";
    const c = useCassette("example/hello-world");
    expect(() => c.gateway()).toThrow(/does not support 'record' mode/);
  });

  it("throws for unsupported modes", () => {
    process.env.LLM_RECORDER_MODE = "weird";
    const c = useCassette("example/hello-world");
    expect(() => c.gateway()).toThrow(/Unsupported LLM_RECORDER_MODE/);
  });
});
