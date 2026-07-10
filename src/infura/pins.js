import { infuraApi } from './api.js';
import { parseNDJSONStream } from '../utils/ndjson.js';

/**
 * Fetch all pinned CIDs from Infura using streaming.
 * Returns { pins, diagnostic } where pins is an array of { cid, type } objects.
 */
export async function fetchPinnedCIDs() {
  console.log('📋 Fetching pinned CIDs from Infura...');

  const res = await infuraApi('/pin/ls?stream=true');
  const entries = [];

  const { linesSkipped } = await parseNDJSONStream(res, (data) => {
    // Stream format:    {"Cid":"Qm...","Type":"recursive"}
    // Non-stream format: {"Keys":{"Qm...":{"Type":"recursive"}}}
    if (data.Cid) {
      entries.push({ cid: data.Cid, type: data.Type || 'unknown' });
    } else if (data.Keys) {
      for (const [cid, info] of Object.entries(data.Keys)) {
        entries.push({ cid, type: info.Type });
      }
    } else {
      // Fallback: iterate top-level keys, skip non-CID fields
      for (const [key, val] of Object.entries(data)) {
        if (key !== 'Type' && typeof val === 'object' && val.Type) {
          entries.push({ cid: key, type: val.Type });
        }
      }
    }
    process.stdout.write(`\r   Found ${entries.length} pinned CID(s)...`);
  });

  console.log(`\r   Found ${entries.length} pinned CID(s)    `);

  let diagnostic = '';
  if (linesSkipped > 0) {
    diagnostic = `⚠️  ${linesSkipped} NDJSON line(s) could not be parsed — some CIDs may have been missed.`;
    console.log(diagnostic);
  }
  console.log('');

  return { pins: entries, diagnostic: diagnostic || null };
}
