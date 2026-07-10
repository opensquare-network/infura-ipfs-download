import fs from 'node:fs';
import path from 'node:path';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { fileTypeFromFile } from 'file-type';
import {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_URL,
  CONCURRENCY,
  validateR2Config,
} from './config.js';

/**
 * Heuristic: does the buffer look like valid UTF-8 text?
 * Uses TextDecoder with fatal=false and checks for replacement characters.
 */
function isUtf8Text(buffer) {
  // Sample up to 16 KB for performance on large files
  const sample = buffer.subarray(0, 16384);
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    // If fatal decoding succeeds, it's valid UTF-8.
    // Reject if the result is mostly null bytes (binary).
    let nullCount = 0;
    for (let i = 0; i < Math.min(decoded.length, 512); i++) {
      if (decoded.charCodeAt(i) === 0) nullCount++;
    }
    return nullCount < 10;
  } catch {
    return false;
  }
}

/**
 * Detect text content MIME type from a UTF-8 string.
 */
function detectTextType(text) {
  const trimmed = text.trimStart();

  // JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'application/json';
    } catch {
      // not valid JSON, treat as plain text
    }
  }

  // HTML
  if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return 'text/html';
  }

  // SVG (can be inline in HTML, check before generic XML)
  if (/^<svg[\s>]/i.test(trimmed) || /^<\?xml[^?]*\?>\s*<svg[\s>]/i.test(trimmed)) {
    return 'image/svg+xml';
  }

  // XML
  if (trimmed.startsWith('<?xml')) {
    return 'application/xml';
  }

  // CSV (simple heuristic: first few lines all have the same number of commas)
  if (trimmed.includes(',') || trimmed.includes('\t')) {
    const lines = trimmed.split('\n').slice(0, 5).filter((l) => l.trim());
    if (lines.length >= 2) {
      const commaCounts = lines.map((l) => (l.match(/,/g) || []).length);
      const tabCounts = lines.map((l) => (l.match(/\t/g) || []).length);
      const allSameCommas = commaCounts.every((c) => c === commaCounts[0] && c > 0);
      const allSameTabs = tabCounts.every((c) => c === tabCounts[0] && c > 0);
      if (allSameCommas) return 'text/csv';
      if (allSameTabs) return 'text/tab-separated-values';
    }
  }

  // CSS
  if (/\b(@media|@import|@charset|@keyframes|@font-face)\b/.test(trimmed.slice(0, 500))
      || /\{[^}]*\}/.test(trimmed.slice(0, 500))) {
    return 'text/css';
  }

  // JavaScript / TypeScript (check after JSON since JS can start with {)
  if (/\b(const|let|var|function|import|export|require|module\.exports)\b/.test(trimmed.slice(0, 500))) {
    return 'text/javascript';
  }

  // Markdown
  if (/^#{1,6}\s/.test(trimmed) || /^[*+-]\s/.test(trimmed) || /\[.*\]\(.*\)/.test(trimmed)) {
    return 'text/markdown';
  }

  // YAML
  if (/^[\w-]+\s*:\s/.test(trimmed) && !trimmed.startsWith('{')) {
    return 'text/yaml';
  }

  // Default text
  return 'text/plain';
}

/**
 * Detect the MIME type of a file.
 * 1. Try magic-byte detection (binary formats: images, video, audio, pdf, etc.)
 * 2. If not detected, check if it's valid UTF-8 text and apply heuristics.
 * 3. Fall back to application/octet-stream.
 * Returns { mime, ext } with ext possibly null.
 */
async function detectFileType(filePath) {
  // Step 1: magic-byte detection for binary formats
  try {
    const result = await fileTypeFromFile(filePath);
    if (result) {
      return { mime: result.mime, ext: result.ext };
    }
  } catch {
    // continue to text detection
  }

  // Step 2: read sample and check for UTF-8 text
  try {
    const fd = fs.openSync(filePath, 'r');
    const sample = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, sample, 0, 16384, 0);
    fs.closeSync(fd);
    const buffer = sample.subarray(0, bytesRead);

    if (isUtf8Text(buffer)) {
      const text = new TextDecoder('utf-8').decode(buffer);
      return { mime: detectTextType(text), ext: null };
    }
  } catch {
    // fall through
  }

  // Step 3: unknown binary
  return { mime: 'application/octet-stream', ext: null };
}

/**
 * Create an S3 client configured for Cloudflare R2.
 */
function createS3Client() {
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Check if a key exists in R2 (lightweight HEAD request).
 * Returns true if the object exists, false otherwise.
 */
async function keyExists(s3Client, bucket, cid) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: cid }));
    return true;
  } catch (err) {
    // NotFound → doesn't exist. Other errors → treat as not found to be safe.
    return false;
  }
}

/**
 * Check-then-upload a single file: if it already exists in R2, skip it;
 * otherwise detect type and upload. Returns result with action label.
 */
async function checkAndUploadFile(s3Client, bucket, filePath, cid) {
  // Check first
  if (await keyExists(s3Client, bucket, cid)) {
    return { action: 'skip', cid };
  }

  // Not in R2 — upload
  const { mime } = await detectFileType(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: cid,
    Body: fileBuffer,
    ContentType: mime,
  }));

  return {
    action: 'upload',
    cid,
    contentType: mime,
    sizeBytes: fileBuffer.length,
  };
}

/**
 * Upload all files in a directory to Cloudflare R2.
 * For each file: checks R2 first, skips if already present, uploads otherwise.
 * Logs progress and returns { uploaded, failed, skipped } counts.
 */
export async function uploadDirectory(dirPath) {
  validateR2Config();

  if (!fs.existsSync(dirPath)) {
    console.error(`❌ Directory not found: ${dirPath}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dirPath).filter((name) => {
    const full = path.join(dirPath, name);
    return fs.statSync(full).isFile();
  });

  if (files.length === 0) {
    console.log('✨ No files found in directory. Nothing to upload.');
    return { uploaded: 0, failed: 0, skipped: 0 };
  }

  console.log(`📦 Processing ${files.length} file(s) → R2 bucket "${R2_BUCKET}"\n`);

  const s3Client = createS3Client();
  const total = files.length;
  const width = String(total).length;
  let done = 0;
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((cid) => checkAndUploadFile(s3Client, R2_BUCKET, path.join(dirPath, cid), cid)),
    );

    for (const r of results) {
      done++;
      const prefix = `[${String(done).padStart(width, '0')}/${total}]`;
      if (r.status === 'rejected') {
        failed++;
        console.error(
          `${prefix} ❌ Failed: ${r.reason?.message || r.reason}`,
        );
      } else if (r.value.action === 'skip') {
        skipped++;
        console.log(`${prefix} ⏭️  ${r.value.cid} (already in R2)`);
      } else {
        uploaded++;
        const sizeKB = (r.value.sizeBytes / 1024).toFixed(1);
        console.log(
          `${prefix} ✅ ${r.value.cid}  (${r.value.contentType}, ${sizeKB} KB)`,
        );
      }
    }

    // Brief pause between batches
    if (i + CONCURRENCY < files.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(
    `\n🎉 Done! ${uploaded} uploaded, ${skipped} skipped, ${failed} failed.`,
  );

  if (R2_PUBLIC_URL) {
    console.log(`   Public URL prefix: ${R2_PUBLIC_URL}/`);
  }

  return { uploaded, failed, skipped };
}
