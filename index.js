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
 * Fetch all pinned CIDs from the project.
 * Returns an array of { cid, type } objects.
 */
async function fetchPinnedCIDs() {
  console.log('📋 Fetching pinned CIDs from Infura...');
  const res = await infuraApi('/pin/ls');
  const data = await res.json();
  const keys = data.Keys || {};

  const entries = Object.entries(keys).map(([cid, info]) => ({
    cid,
    type: info.Type, // "recursive", "direct", etc.
  }));

  console.log(`   Found ${entries.length} pinned CID(s)\n`);
  return entries;
}

/**
 * Download a single CID and save it to disk.
 * Directories are returned as tar archives — we save them with a .tar extension
 * so they are easy to extract.
 */
async function downloadCID({ cid, type }, index, total, downloadDir) {
  const prefix = `[${String(index + 1).padStart(String(total).length, '0')}/${total}]`;

  try {
    console.log(`${prefix} ⬇️  Downloading ${cid} (${type})...`);

    const res = await infuraApi(`/get?arg=${cid}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Directories come back as tar archives; individual files are raw bytes.
    // We peek at the magic bytes to decide the extension.
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
