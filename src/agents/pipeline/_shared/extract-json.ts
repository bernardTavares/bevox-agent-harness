/**
 * Robust JSON extraction for pipeline-agent LLM output (finding a-agents-03).
 *
 * Pipeline agents (MessageAnalyzer, MemoryExtractor) ask the model for a single
 * JSON object. In practice providers do not always honour "JSON only":
 *   - some wrap the object in a ```json ... ``` (or bare ```) markdown fence,
 *   - some prepend a courtesy sentence ("Sure! Here is ..."),
 *   - some append trailing prose after the object.
 *
 * A raw `JSON.parse(content)` throws on all of the above, turning a perfectly
 * recoverable response into a hard pipeline failure. This helper strips fences
 * and surrounding prose, isolates the FIRST balanced top-level JSON object
 * (brace-matching while respecting string literals and escapes), and parses it.
 *
 * On genuinely non-JSON input it throws a typed {@link JsonExtractionError} so
 * callers keep failing loudly — it never returns a silently-wrong shape.
 */

/** Thrown when the LLM output contains no parseable JSON object. */
export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonExtractionError";
  }
}

/**
 * Strip a single leading/trailing markdown code fence (```json / ``` / ~~~)
 * if the trimmed body is fully enclosed by one. Inner content is returned
 * untrimmed-of-meaning (only the fence lines are removed).
 */
function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
  if (!fenceMatch) return trimmed;

  const fence = fenceMatch[1]!;
  // Drop the opening fence line entirely (handles ```json, ```JSON, ``` etc.)
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return trimmed; // a lone fence with no body
  let body = trimmed.slice(firstNewline + 1);

  // Drop the closing fence if present.
  const closeIdx = body.lastIndexOf(fence);
  if (closeIdx !== -1) {
    body = body.slice(0, closeIdx);
  }
  return body.trim();
}

/**
 * Find the first balanced top-level JSON object substring starting at the
 * first `{`. Brace counting ignores braces that appear inside string literals
 * and honours backslash escapes. Returns null if no balanced object is found.
 */
function sliceFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // unbalanced — no complete object
}

/**
 * Extract and parse the first balanced JSON object from an LLM response.
 *
 * @typeParam T - expected parsed shape (no runtime validation is performed
 *   here; callers that need schema validation should run Zod on the result).
 * @throws {JsonExtractionError} when no parseable JSON object is present.
 */
export function extractJsonObject<T = unknown>(raw: string): T {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new JsonExtractionError("LLM output is empty; expected a JSON object");
  }

  const defenced = stripCodeFence(raw);

  // Fast path: the (defenced) body is already a clean JSON object/value.
  const directCandidate = defenced.trim();
  if (directCandidate.startsWith("{")) {
    try {
      return JSON.parse(directCandidate) as T;
    } catch {
      // fall through to balanced-slice extraction (handles trailing prose)
    }
  }

  const sliced = sliceFirstBalancedObject(defenced);
  if (sliced === null) {
    throw new JsonExtractionError(
      "LLM output does not contain a JSON object",
    );
  }

  try {
    return JSON.parse(sliced) as T;
  } catch (err) {
    throw new JsonExtractionError(
      `LLM output contained a malformed JSON object: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
