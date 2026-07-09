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
 * Upload a single file to R2 with auto-detected Content-Type.
 * Returns { cid, key, contentType, sizeBytes } on success.
 */
async function uploadFile(s3Client, bucket, filePath, cid) {
  const { mime } = await detectFileType(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: cid,
    Body: fileBuffer,
    ContentType: mime,
  });

  await s3Client.send(command);

  return {
    cid,
    key: cid,
    contentType: mime,
    sizeBytes: fileBuffer.length,
  };
}

/**
 * Check which CIDs already exist in the R2 bucket.
 * Uses HeadObject (lightweight) concurrently, respecting CONCURRENCY.
 * Returns a Set of existing CIDs.
 */
async function checkExistingKeys(s3Client, bucket, cids) {
  const existing = new Set();

  if (cids.length === 0) return existing;

  process.stdout.write(`🔍 Checking R2 for ${cids.length} key(s)...`);

  for (let i = 0; i < cids.length; i += CONCURRENCY) {
    const batch = cids.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (cid) => {
        try {
          await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: cid }));
          return cid; // exists
        } catch (err) {
          // NotFound means the object doesn't exist — that's expected for new files
          if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            return null;
          }
          // Other errors (network, auth, etc.) — treat as "not found" to be safe
          // and let the upload attempt catch real issues
          return null;
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        existing.add(r.value);
      }
    }
  }

  process.stdout.write(`\r🔍 Checking R2 for ${cids.length} key(s)... ${existing.size} already exist\n`);
  return existing;
}

/**
 * Upload all files in a directory to Cloudflare R2.
 * Checks R2 first and skips files that already exist.
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

  const s3Client = createS3Client();

  // Pre-check: which files already exist in R2?
  const existingKeys = await checkExistingKeys(s3Client, R2_BUCKET, files);
  const toUpload = files.filter((cid) => !existingKeys.has(cid));
  const skipped = existingKeys.size;

  if (toUpload.length === 0) {
    console.log(`✨ All ${files.length} file(s) already in R2. Nothing to upload.\n`);
    if (R2_PUBLIC_URL) {
      console.log(`   Public URL prefix: ${R2_PUBLIC_URL}/`);
    }
    return { uploaded: 0, failed: 0, skipped };
  }

  console.log(
    `📦 ${skipped > 0 ? `${skipped} skipped, ` : ''}${toUpload.length} to upload → R2 bucket "${R2_BUCKET}"\n`,
  );

  const total = toUpload.length;
  const width = String(total).length;
  let done = 0;
  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < toUpload.length; i += CONCURRENCY) {
    const batch = toUpload.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((cid) => uploadFile(s3Client, R2_BUCKET, path.join(dirPath, cid), cid)),
    );

    for (const r of results) {
      done++;
      const prefix = `[${String(done).padStart(width, '0')}/${total}]`;
      if (r.status === 'rejected') {
        failed++;
        console.error(
          `${prefix} ❌ Upload failed: ${r.reason?.message || r.reason}`,
        );
      } else {
        uploaded++;
        const sizeKB = (r.value.sizeBytes / 1024).toFixed(1);
        console.log(
          `${prefix} ✅ ${r.value.cid}  (${r.value.contentType}, ${sizeKB} KB)`,
        );
      }
    }

    // Brief pause between batches
    if (i + CONCURRENCY < toUpload.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(
    `\n🎉 Upload complete! ${uploaded} succeeded, ${failed} failed, ${skipped} skipped.`,
  );

  if (R2_PUBLIC_URL) {
    console.log(`   Public URL prefix: ${R2_PUBLIC_URL}/`);
  }

  return { uploaded, failed, skipped };
}
