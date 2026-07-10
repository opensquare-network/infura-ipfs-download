import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_NAME } from './src/config.js';
import { downloadCID } from './src/download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cid = process.argv[2];

if (!cid) {
  console.error(
    '❌ Please provide a CID to download.\n' +
      '   Usage: node fetch.js <cid>\n' +
      '   Example: pnpm run fetch QmSomeCidHere',
  );
  process.exit(1);
}

const downloadDir = path.join(__dirname, 'downloads', PROJECT_NAME);

console.log(`📥 Downloading ${cid}...`);

const result = await downloadCID(cid, downloadDir);

if (result.ok) {
  console.log(`✅ Done! ${result.cid} (${result.sizeKB} KB) → ${downloadDir}`);
} else {
  console.error(`❌ Failed: ${result.error}`);
  process.exit(1);
}
