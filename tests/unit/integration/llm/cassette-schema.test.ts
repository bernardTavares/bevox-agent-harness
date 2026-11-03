import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, it, expect } from "vitest";

import { cassetteFileSchema } from "../../../../src/integration/llm/cassette-schema.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  __dirname,
  "../../../fixtures/cassettes/example/hello-world.cassette.json",
);

describe("cassette-schema", () => {
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

  it("validates a well-formed cassette", () => {
    expect(() => cassetteFileSchema.parse(raw)).not.toThrow();
  });

  it("rejects cassette with wrong schema_version", () => {
    const bad = { ...raw, schema_version: "2" };
    expect(() => cassetteFileSchema.parse(bad)).toThrow();
  });

  it("rejects entry with non-hex request_hash", () => {
    const bad = {
      ...raw,
      entries: [{ ...raw.entries[0], request_hash: "not-a-sha-256" }],
    };
    expect(() => cassetteFileSchema.parse(bad)).toThrow();
  });

  it("defaults n_tools to 0 when omitted", () => {
    const cloned = JSON.parse(JSON.stringify(raw));
    delete cloned.entries[0].request_summary.n_tools;
    const parsed = cassetteFileSchema.parse(cloned);
    expect(parsed.entries[0].request_summary.n_tools).toBe(0);
  });
});
