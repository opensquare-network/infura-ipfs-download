import fs from 'node:fs';
import path from 'node:path';
import { INFURA_IPFS_GATEWAY, AUTH } from './config.js';

/**
 * Download a single CID via the Infura IPFS gateway.
 * Returns { ok: true, cid, sizeKB } or { ok: false, error }.
 */
export async function downloadCID(cid, downloadDir) {
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
