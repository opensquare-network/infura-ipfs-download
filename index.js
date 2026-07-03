import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ID = process.env.INFURA_PROJECT_ID;
const PROJECT_SECRET = process.env.INFURA_PROJECT_SECRET;

if (!PROJECT_ID || !PROJECT_SECRET) {
  console.error(
    '❌ Missing required environment variables.\n' +
    '   Copy .env.example to .env and fill in your Infura credentials:',
  );
  console.error('   INFURA_PROJECT_ID=xxxxxxxx');
  console.error('   INFURA_PROJECT_SECRET=xxxxxxxx');
  process.exit(1);
}

const INFURA_IPFS_API = 'https://ipfs.infura.io:5001/api/v0';
const INFURA_IPFS_GATEWAY = process.env.IPFS_ENDPOINT || 'https://ipfs.infura.io/ipfs';
const AUTH = Buffer.from(`${PROJECT_ID}:${PROJECT_SECRET}`).toString('base64');
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the Infura IPFS API.
 */
async function infuraApi(endpoint, options = {}) {
  const url = `${INFURA_IPFS_API}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    ...options,
    headers: {
      Authorization: `Basic ${AUTH}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Infura API error (${res.status}): ${endpoint}\n${body.slice(0, 500)}`,
    );
  }

  return res;
}

/**
 * Fetch all pinned CIDs from the project using streaming.
 * Returns an array of { cid, type } objects.
 */
async function fetchPinnedCIDs() {
  console.log('📋 Fetching pinned CIDs from Infura...');

  const res = await infuraApi('/pin/ls?stream=true');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const entries = [];

  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep the last (potentially incomplete) chunk in the buffer
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        // Stream format:    {"Cid":"Qm...","Type":"recursive"}
        // Non-stream format: {"Keys":{"Qm...":{"Type":"recursive"}}}
        if (data.Cid) {
          entries.push({ cid: data.Cid, type: data.Type || 'unknown' });
        } else if (data.Keys) {
          for (const [cid, info] of Object.entries(data.Keys)) {
            entries.push({ cid, type: info.Type });
          }
        } else {
          // Fallback: iterate top-level keys
          for (const [key, val] of Object.entries(data)) {
            if (key !== 'Type' && typeof val === 'object' && val.Type) {
              entries.push({ cid: key, type: val.Type });
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
    process.stdout.write(`\r   Found ${entries.length} pinned CID(s)...`);
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.Cid) {
        entries.push({ cid: data.Cid, type: data.Type || 'unknown' });
      } else if (data.Keys) {
        for (const [cid, info] of Object.entries(data.Keys)) {
          entries.push({ cid, type: info.Type });
        }
      }
    } catch { /* skip */ }
  }

  console.log(`\r   Found ${entries.length} pinned CID(s)    \n`);
  return entries;
}

/**
 * Download a single CID via the Infura IPFS gateway.
 * Returns { ok: true } or { ok: false, error }.
 */
async function downloadCID(cid, downloadDir) {
  try {
    const res = await fetch(`${INFURA_IPFS_GATEWAY}/${cid}`, {
      headers: { Authorization: `Basic ${AUTH}` },
    });

    if (!res.ok) {
      return { ok: false, error: `Gateway returned ${res.status}` };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const filePath = path.join(downloadDir, cid);
    fs.writeFileSync(filePath, buffer);

    const sizeKB = (buffer.length / 1024).toFixed(1);
    return { ok: true, cid, sizeKB };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectName = process.env.INFURA_PROJECT_NAME || PROJECT_ID;
  const downloadDir = path.join(__dirname, 'downloads', projectName);

  console.log(`🚀 Infura IPFS Downloader`);
  console.log(`   Project:     ${projectName} (${PROJECT_ID})`);
  console.log(`   Output:      ${downloadDir}`);
  console.log(`   Concurrency: ${CONCURRENCY}\n`);

  const pins = await fetchPinnedCIDs();

  if (pins.length === 0) {
    console.log('✨ No pinned CIDs found. Nothing to download.');
    return;
  }

  fs.mkdirSync(downloadDir, { recursive: true });

  // Resume: skip CIDs already on disk
  const toDownload = [];
  let skipped = 0;
  for (const { cid } of pins) {
    if (fs.existsSync(path.join(downloadDir, cid))) {
      skipped++;
    } else {
      toDownload.push(cid);
    }
  }
  if (skipped > 0) {
    console.log(`⏭️  ${skipped} already downloaded, ${toDownload.length} remaining\n`);
  }

  if (toDownload.length === 0) {
    console.log('✨ All files already downloaded.');
    return;
  }

  // Download in batches
  let done = 0;
  let failed = 0;
  const total = toDownload.length;
  const width = String(total).length;

  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((cid) => downloadCID(cid, downloadDir)),
    );

    for (const r of results) {
      done++;
      const prefix = `[${String(done).padStart(width, '0')}/${total}]`;
      if (r.status === 'rejected') {
        failed++;
        console.error(`${prefix} ❌ Failed: ${r.reason?.message || r.reason}`);
      } else if (r.value.ok) {
        console.log(`${prefix} ✅ ${r.value.cid} (${r.value.sizeKB} KB)`);
      } else {
        failed++;
        console.error(`${prefix} ❌ Failed: ${r.value.error}`);
      }
    }

    // Brief pause between batches
    if (i + CONCURRENCY < toDownload.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(
    `\n🎉 Done! ${total - failed} succeeded, ${failed} failed, ${skipped} skipped. Files in: ${downloadDir}`,
  );
}

main().catch((err) => {
  console.error('\n💥 Unexpected error:', err.message);
  process.exit(1);
});
