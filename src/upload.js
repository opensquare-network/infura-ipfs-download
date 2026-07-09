import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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
 * Detect the MIME type of a file by reading its magic bytes.
 * Falls back to application/octet-stream when detection fails.
 * Returns { mime, ext } with ext possibly null.
 */
async function detectFileType(filePath) {
  try {
    const result = await fileTypeFromFile(filePath);
    if (result) {
      return { mime: result.mime, ext: result.ext };
    }
  } catch {
    // if detection fails for any reason, fall through to default
  }
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
 * Upload all files in a directory to Cloudflare R2.
 * Logs progress and returns { uploaded, failed } counts.
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
    return { uploaded: 0, failed: 0 };
  }

  console.log(`📦 Uploading ${files.length} file(s) to R2 bucket "${R2_BUCKET}"...\n`);

  const s3Client = createS3Client();
  const total = files.length;
  const width = String(total).length;
  let done = 0;
  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
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
    if (i + CONCURRENCY < files.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(
    `\n🎉 Upload complete! ${uploaded} succeeded, ${failed} failed.`,
  );

  if (R2_PUBLIC_URL) {
    console.log(`   Public URL prefix: ${R2_PUBLIC_URL}/`);
  }

  return { uploaded, failed };
}
