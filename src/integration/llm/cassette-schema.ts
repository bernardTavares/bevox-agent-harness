/**
 * Cassette schema — versioned JSON format for recorded LLM interactions.
 *
 * Cassettes are read/written by `CassetteStore` and consumed by `LLMRecorder`
 * (record mode) and `LLMReplayer` (replay mode). The shape MUST stay backwards
 * compatible within a `schema_version`; bumping the literal is a breaking
 * change and requires a migration of all existing cassettes.
 */
import { z } from "zod";

export const cassetteSchemaVersion = "1" as const;

export const cassetteEntrySchema = z.object({
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_summary: z.object({
    model: z.string(),
    provider: z.string().optional(),
    temperature: z.number().optional(),
    n_messages: z.number().int().min(0),
    // Post-review: default(0) so fixtures never carry an ambiguous `undefined`.
    n_tools: z.number().int().min(0).default(0),
    has_response_schema: z.boolean(),
  }),
  response: z.object({
    content: z.string().nullable(),
    tool_calls: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      }),
    ),
    usage: z.object({
      input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
      total_tokens: z.number().int().min(0),
    }),
    model: z.string(),
    provider: z.string(),
    // Latency captured during the original recording. On replay this value is
    // returned verbatim — it does NOT reflect replay wall time. Tests that
    // assert real latency must inject a clock.
    latency_ms: z.number().int().min(0),
  }),
  // Zod 4 — use `z.iso.datetime({ offset: true })` (the v3 `z.string().datetime()` is deprecated).
  recorded_at: z.iso.datetime({ offset: true }),
});

export const cassetteFileSchema = z.object({
  schema_version: z.literal(cassetteSchemaVersion),
  name: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  entries: z.array(cassetteEntrySchema),
});

export type CassetteFile = z.infer<typeof cassetteFileSchema>;
export type CassetteEntry = z.infer<typeof cassetteEntrySchema>;
