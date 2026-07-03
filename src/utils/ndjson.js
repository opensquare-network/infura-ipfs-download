/**
 * Parse an NDJSON stream from a fetch Response.
 * Calls `onLine(parsedObject)` for each complete line.
 * Flushes any remaining buffer at the end.
 */
export async function parseNDJSONStream(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete chunk

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }

  // flush remaining buffer
  if (buffer.trim()) {
    try {
      onLine(JSON.parse(buffer));
    } catch {
      /* skip */
    }
  }
}
