import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach } from "vitest";

import type { CassetteEntry } from "../../../../src/integration/llm/cassette-schema.js";
import {
  CassetteStore,
  getDefaultCassetteStore,
  resetDefaultCassetteStore,
} from "../../../../src/integration/llm/cassette-store.js";
import { CassetteValidationError } from "../../../../src/integration/llm/errors.js";

function makeEntry(hash: string, content = "ok"): CassetteEntry {
  return {
    request_hash: hash,
    request_summary: {
      model: "gpt-4o-mini",
      n_messages: 1,
      n_tools: 0,
      has_response_schema: false,
    },
    response: {
      content,
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      model: "gpt-4o-mini",
      provider: "openai",
      latency_ms: 10,
    },
    recorded_at: new Date().toISOString(),
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("CassetteStore", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cassette-store-"));
    store = new CassetteStore(dir);
  });

  it("returns null when the cassette file does not exist", async () => {
    expect(await store.load("missing")).toBeNull();
  });

  it("creates, appends, and re-loads a cassette", async () => {
    await store.append("test/sample", makeEntry(HASH_A));
    const file = await store.load("test/sample");
    expect(file?.entries).toHaveLength(1);
    expect(file?.entries[0]?.request_hash).toBe(HASH_A);
  });

  it("appends two distinct entries", async () => {
    await store.append("test/two", makeEntry(HASH_A));
    await store.append("test/two", makeEntry(HASH_B));
    const file = await store.load("test/two");
    expect(file?.entries).toHaveLength(2);
  });

  it("dedups entries with the same hash (idempotent append)", async () => {
    await store.append("test/dup", makeEntry(HASH_A, "first"));
    await store.append("test/dup", makeEntry(HASH_A, "second"));
    const file = await store.load("test/dup");
    expect(file?.entries).toHaveLength(1);
    // Replacement semantics — last write wins.
    expect(file?.entries[0]?.response.content).toBe("second");
  });

  it("creates intermediate directories", async () => {
    await store.append("nested/deep/path/x", makeEntry(HASH_A));
    const filePath = path.join(dir, "nested/deep/path/x.cassette.json");
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it("throws CassetteValidationError on malformed JSON content", async () => {
    const filePath = path.join(dir, "bad.cassette.json");
    await fs.writeFile(filePath, JSON.stringify({ schema_version: "1", name: "bad" }), "utf-8");
    await expect(store.load("bad")).rejects.toBeInstanceOf(CassetteValidationError);
  });

  it("find() returns matching entry by hash", async () => {
    await store.append("test/find", makeEntry(HASH_A));
    const file = await store.load("test/find");
    expect(store.find(file!, HASH_A)?.request_hash).toBe(HASH_A);
    expect(store.find(file!, HASH_B)).toBeUndefined();
  });

  it("caches loaded files in memory", async () => {
    await store.append("test/cache", makeEntry(HASH_A));
    const first = await store.load("test/cache");
    // Mutate file directly bypassing the store — cache should hide this.
    const filePath = path.join(dir, "test/cache.cassette.json");
    await fs.writeFile(filePath, "garbage", "utf-8");
    const second = await store.load("test/cache");
    expect(second).toBe(first);
  });
});

describe("getDefaultCassetteStore singleton", () => {
  it("returns the same instance on repeated calls", () => {
    resetDefaultCassetteStore();
    const a = getDefaultCassetteStore("foo");
    const b = getDefaultCassetteStore("bar");
    expect(a).toBe(b);
    resetDefaultCassetteStore();
  });
});
