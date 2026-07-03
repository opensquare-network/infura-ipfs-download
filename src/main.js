import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_NAME, CONCURRENCY } from './config.js';
import { fetchPinnedCIDs } from './infura/pins.js';
import { downloadCID } from './download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function main() {
  const downloadDir = path.join(__dirname, '..', 'downloads', PROJECT_NAME);

  console.log(`🚀 Infura IPFS Downloader`);
  console.log(`   Project:     ${PROJECT_NAME}`);
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
    console.log(
      `⏭️  ${skipped} already downloaded, ${toDownload.length} remaining\n`,
    );
  }

  if (toDownload.length === 0) {
    console.log('✨ All files already downloaded.');
    return;
  }

  // Download in batches with controlled concurrency
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
        console.error(
          `${prefix} ❌ Failed: ${r.reason?.message || r.reason}`,
        );
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
