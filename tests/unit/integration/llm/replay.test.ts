import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach } from "vitest";

import type {
  LLMRequestOptions,
  LLMResponse,
} from "../../../../src/integration/llm-gateway.js";
import type { CassetteEntry } from "../../../../src/integration/llm/cassette-schema.js";
import { CassetteStore } from "../../../../src/integration/llm/cassette-store.js";
import { CassetteMissError } from "../../../../src/integration/llm/errors.js";
import { LLMReplayer } from "../../../../src/integration/llm/replay.js";
import { hashRequest } from "../../../../src/integration/llm/request-hasher.js";

const MODEL = "gpt-4o-mini";

const baseOpts: LLMRequestOptions = {
  messages: [{ role: "user", content: "hi" }],
};

function buildEntry(hash: string): CassetteEntry {
  return {
    request_hash: hash,
    request_summary: {
      model: MODEL,
      n_messages: 1,
      n_tools: 0,
      has_response_schema: false,
    },
    response: {
      content: "recorded",
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      model: MODEL,
      provider: "openai",
      latency_ms: 42,
    } satisfies LLMResponse,
    recorded_at: new Date().toISOString(),
  };
}

describe("LLMReplayer", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "replay-"));
    store = new CassetteStore(dir);
  });

  it("throws CassetteMissError when cassette file absent", async () => {
    const replayer = new LLMReplayer(store, "missing", MODEL);
    await expect(replayer.complete(baseOpts)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it("throws CassetteMissError when entry hash not found", async () => {
    await store.append("test", buildEntry(hashRequest(baseOpts, MODEL)));
    const replayer = new LLMReplayer(store, "test", MODEL);
    const different: LLMRequestOptions = { messages: [{ role: "user", content: "DIFFERENT" }] };
    await expect(replayer.complete(different)).rejects.toThrow(/no entry for hash/);
  });

  it("returns the recorded response on hash hit", async () => {
    await store.append("test", buildEntry(hashRequest(baseOpts, MODEL)));
    const replayer = new LLMReplayer(store, "test", MODEL);
    const res = await replayer.complete(baseOpts);
    expect(res.content).toBe("recorded");
    expect(res.latency_ms).toBe(42);
  });

  it("propagates CassetteMissError with the cassette name and hash", async () => {
    const replayer = new LLMReplayer(store, "miss-target", MODEL);
    try {
      await replayer.complete(baseOpts);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CassetteMissError);
      const e = err as CassetteMissError;
      expect(e.cassetteName).toBe("miss-target");
      expect(e.requestHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
