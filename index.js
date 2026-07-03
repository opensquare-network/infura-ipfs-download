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
const INFURA_IPFS_GATEWAY = 'https://ipfs.infura.io/ipfs';
const AUTH = Buffer.from(`${PROJECT_ID}:${PROJECT_SECRET}`).toString('base64');

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
        // Each streamed line is an object keyed by CID
        for (const [cid, info] of Object.entries(data)) {
          entries.push({ cid, type: info.Type });
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
      for (const [cid, info] of Object.entries(data)) {
        entries.push({ cid, type: info.Type });
      }
    } catch { /* skip */ }
  }

  console.log(`\r   Found ${entries.length} pinned CID(s)    \n`);
  return entries;
}

/**
 * Download a single CID via the Infura IPFS gateway and save it to disk.
 * File CIDs are saved directly; directory CIDs are saved as .tar via the API.
 */
async function downloadCID({ cid, type }, index, total, downloadDir) {
  const prefix = `[${String(index + 1).padStart(String(total).length, '0')}/${total}]`;

  try {
    console.log(`${prefix} ⬇️  Downloading ${cid} (${type})...`);

    // Try gateway first — works reliably for individual files
    let res = await fetch(`${INFURA_IPFS_GATEWAY}/${cid}`, {
      headers: { Authorization: `Basic ${AUTH}` },
    });

    // If gateway returns HTML (directory listing) or fails, fall back to API /get
    const contentType = res.headers.get('content-type') || '';
    const isDirectory = res.ok && contentType.includes('text/html');

    if (!res.ok || isDirectory) {
      if (isDirectory) {
        console.log(`${prefix}    📁 Directory detected, fetching as tar...`);
      }
      res = await infuraApi(`/get?arg=${cid}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Directories come back as tar archives — detect by magic bytes.
    const isTar =
      buffer.length >= 262 &&
      buffer[257] === 0x75 &&
      buffer[258] === 0x73 &&
      buffer[259] === 0x74 &&
      buffer[260] === 0x61 &&
      buffer[261] === 0x72;

    const ext = isTar ? '.tar' : '';
    const filename = `${cid}${ext}`;
    const filePath = path.join(downloadDir, filename);

    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const sizeKB = (buffer.length / 1024).toFixed(1);
    console.log(`${prefix} ✅ Saved: ${filename} (${sizeKB} KB)`);
  } catch (err) {
    console.error(`${prefix} ❌ Failed: ${cid} — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectName = process.env.INFURA_PROJECT_NAME || PROJECT_ID;
  const downloadDir = path.join(__dirname, 'downloads', projectName);

  console.log(`🚀 Infura IPFS Downloader`);
  console.log(`   Project:  ${projectName} (${PROJECT_ID})`);
  console.log(`   Output:   ${downloadDir}\n`);

  const pins = await fetchPinnedCIDs();

  if (pins.length === 0) {
    console.log('✨ No pinned CIDs found. Nothing to download.');
    return;
  }

  // Download sequentially to avoid hammering the API
  for (let i = 0; i < pins.length; i++) {
    await downloadCID(pins[i], i, pins.length, downloadDir);
  }

  console.log(`\n🎉 Done! Files saved to: ${downloadDir}`);
}

main().catch((err) => {
  console.error('\n💥 Unexpected error:', err.message);
  process.exit(1);
});
