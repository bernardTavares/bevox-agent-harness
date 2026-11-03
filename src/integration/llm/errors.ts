/**
 * Cassette-specific error types.
 *
 * `CassetteMissError` is thrown by `LLMReplayer` when the cassette file is
 * absent or no entry matches the request hash. It is the **only** failure
 * mode of the replayer (modulo I/O / parse errors) — it MUST stay strict so
 * tests fail loudly when a recording is stale.
 *
 * `CassetteValidationError` wraps Zod parse failures from `CassetteStore.load`.
 */
export class CassetteMissError extends Error {
  constructor(
    public readonly cassetteName: string,
    public readonly requestHash: string,
  ) {
    super(`Cassette miss: ${cassetteName} has no entry for hash ${requestHash.slice(0, 12)}…`);
    this.name = "CassetteMissError";
  }
}

export class CassetteValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly zodIssues: unknown,
  ) {
    super(`Invalid cassette at ${path}`);
    this.name = "CassetteValidationError";
  }
}
