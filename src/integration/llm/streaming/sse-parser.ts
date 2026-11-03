/**
 * Generic SSE (Server-Sent Events) parser used by OpenAI and Anthropic adapters.
 *
 * Reads the raw `Response.body` byte stream and yields parsed `{event, data}`
 * pairs as soon as a `\n\n` terminator is seen. Multi-line `data:` fields are
 * concatenated (per the SSE spec).
 *
 * Notes:
 *  - We do NOT depend on a third-party SSE lib; this keeps the harness slim.
 *  - The decoder is invoked with `{ stream: true }` so multi-byte UTF-8
 *    characters spanning chunk boundaries are handled.
 *  - On abort (signal), the underlying `fetch` rejects with `AbortError` and
 *    this generator simply stops.
 */
export async function* parseSSE(
  response: Response,
): AsyncIterable<{ event?: string; data: string }> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = raw.split("\n");
        const evt: { event?: string; data: string } = { data: "" };
        for (const line of lines) {
          if (line.startsWith("event:")) {
            evt.event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const piece = line.slice(5).trimStart();
            evt.data = evt.data ? `${evt.data}\n${piece}` : piece;
          }
        }
        if (evt.data) yield evt;
      }
    }
    // Flush trailing buffer (rare; some providers send last frame without \n\n)
    const tail = buffer.trim();
    if (tail.length > 0) {
      const lines = tail.split("\n");
      const evt: { event?: string; data: string } = { data: "" };
      for (const line of lines) {
        if (line.startsWith("event:")) evt.event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const piece = line.slice(5).trimStart();
          evt.data = evt.data ? `${evt.data}\n${piece}` : piece;
        }
      }
      if (evt.data) yield evt;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
