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

  const { pins, diagnostic } = await fetchPinnedCIDs();

  if (pins.length === 0) {
    console.log('✨ No pinned CIDs found. Nothing to download.');
    if (diagnostic) console.log(`   ${diagnostic}`);
    return;
  }

  fs.mkdirSync(downloadDir, { recursive: true });

  // Clean up any stale .tmp files from a previous interrupted run
  for (const name of fs.readdirSync(downloadDir)) {
    if (name.endsWith('.tmp')) {
      const tmpPath = path.join(downloadDir, name);
      console.log(`🧹 Cleaning up stale tmp file: ${name}`);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  // Resume: skip CIDs that are already on disk AND non-empty
  // A 0-byte file means a previous download was interrupted → re-download
  const toDownload = [];
  let skipped = 0;
  let resumed = 0;
  for (const { cid } of pins) {
    const filePath = path.join(downloadDir, cid);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        skipped++;
      } else {
        // Empty file — clean it up and re-download
        fs.unlinkSync(filePath);
        toDownload.push(cid);
        resumed++;
      }
    } else {
      toDownload.push(cid);
    }
  }
  if (skipped > 0 || resumed > 0) {
    const parts = [];
    if (skipped > 0) parts.push(`${skipped} already downloaded`);
    if (resumed > 0) parts.push(`${resumed} partial file(s) re-downloading`);
    console.log(
      `⏭️  ${parts.join(', ')}, ${toDownload.length} remaining\n`,
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
    `\n🎉 Done! ${total - failed} succeeded, ${failed} failed, ${skipped} skipped (${resumed} resumed). Files in: ${downloadDir}`,
  );
}
