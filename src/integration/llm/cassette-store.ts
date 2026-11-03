/**
 * `CassetteStore` — filesystem I/O for LLM cassettes.
 *
 * - `load(name)` reads `{rootDir}/{name}.cassette.json`, validates with Zod,
 *   and memoizes the parsed file. Returns `null` if the file does not exist.
 * - `append(name, entry)` upserts an entry (replacing any existing one with
 *   the same `request_hash`) and writes the file atomically-ish (write then
 *   the OS handles fsync — good enough for test fixtures).
 * - `find(cassette, hash)` is a pure lookup helper.
 *
 * Post-review: callers in production code path SHOULD share a module-level
 * singleton via `getDefaultCassetteStore(rootDir)` to keep the cache warm
 * across the worker lifetime. Tests instantiate their own stores rooted at
 * tmpdir.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeEntry } from "./cassette-sanitizer.js";
import {
  cassetteFileSchema,
  cassetteSchemaVersion,
  type CassetteEntry,
  type CassetteFile,
} from "./cassette-schema.js";
import { CassetteValidationError } from "./errors.js";

export class CassetteStore {
  private cache = new Map<string, CassetteFile>();

  constructor(private readonly rootDir: string) {}

  private filePathFor(name: string): string {
    return path.join(this.rootDir, `${name}.cassette.json`);
  }

  async load(name: string): Promise<CassetteFile | null> {
    if (this.cache.has(name)) return this.cache.get(name) ?? null;
    const filePath = this.filePathFor(name);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = cassetteFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new CassetteValidationError(filePath, parsed.error.issues);
    }
    this.cache.set(name, parsed.data);
    return parsed.data;
  }

  async append(name: string, entry: CassetteEntry): Promise<void> {
    const existing =
      (await this.load(name)) ??
      ({
        schema_version: cassetteSchemaVersion,
        name,
        created_at: new Date().toISOString(),
        entries: [],
      } satisfies CassetteFile);

    // Replace entry with same hash (re-record scenario). This keeps cassettes
    // idempotent — running record twice with no logical changes produces no
    // diff.
    const sanitized = sanitizeEntry(entry);
    const filtered = existing.entries.filter((e) => e.request_hash !== sanitized.request_hash);
    filtered.push(sanitized);
    const updated: CassetteFile = { ...existing, entries: filtered };

    this.cache.set(name, updated);
    const filePath = this.filePathFor(name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  }

  find(cassette: CassetteFile, requestHash: string): CassetteEntry | undefined {
    return cassette.entries.find((e) => e.request_hash === requestHash);
  }

  /** Test helper — drop in-memory cache (does NOT delete files). */
  clearCache(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (post-review fix)
//
// `createLLMGateway` is called once per execution; without a shared cache the
// recorder/replayer would re-read every cassette per request. Production code
// reaches this via `getDefaultCassetteStore`, which honours an explicit
// `rootDir` only on first call (subsequent calls return the same instance).
// Tests bypass this entirely by instantiating `new CassetteStore(tmpDir)`.
// ---------------------------------------------------------------------------
let storeSingleton: CassetteStore | undefined;

export function getDefaultCassetteStore(rootDir: string): CassetteStore {
  if (!storeSingleton) {
    storeSingleton = new CassetteStore(rootDir);
  }
  return storeSingleton;
}

/** Test-only: reset the module-level singleton (e.g. between suites). */
export function resetDefaultCassetteStore(): void {
  storeSingleton = undefined;
}
