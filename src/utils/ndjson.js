/**
 * Parse an NDJSON stream from a fetch Response.
 * Calls `onLine(parsedObject)` for each complete line.
 * Flushes any remaining buffer at the end.
 * Returns { linesParsed, linesSkipped } for diagnostics.
 */
export async function parseNDJSONStream(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let linesParsed = 0;
  let linesSkipped = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onLine(JSON.parse(trimmed));
        linesParsed++;
      } catch {
        linesSkipped++;
      }
    }
  }

  // Flush remaining buffer + any leftover bytes in the TextDecoder
  buffer += decoder.decode();
  if (buffer.trim()) {
    try {
      onLine(JSON.parse(buffer.trim()));
      linesParsed++;
    } catch {
      linesSkipped++;
    }
  }

  return { linesParsed, linesSkipped };
}
