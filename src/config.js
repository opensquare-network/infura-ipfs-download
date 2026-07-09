import 'dotenv/config';

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

export const PROJECT_NAME =
  process.env.INFURA_PROJECT_NAME || PROJECT_ID;

export const AUTH = Buffer.from(
  `${PROJECT_ID}:${PROJECT_SECRET}`,
).toString('base64');

export const INFURA_IPFS_API = 'https://ipfs.infura.io:5001/api/v0';

export const INFURA_IPFS_GATEWAY =
  process.env.IPFS_ENDPOINT || 'https://ipfs.infura.io/ipfs';

export const CONCURRENCY =
  parseInt(process.env.CONCURRENCY, 10) || 3;

// --- Cloudflare R2 ---
export const R2_ENDPOINT = process.env.R2_ENDPOINT;
export const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
export const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
export const R2_BUCKET = process.env.R2_BUCKET;
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

export function validateR2Config() {
  const missing = [];
  if (!R2_ENDPOINT) missing.push('R2_ENDPOINT');
  if (!R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!R2_BUCKET) missing.push('R2_BUCKET');
  if (missing.length > 0) {
    console.error(
      '❌ Missing required R2 environment variables.\n' +
        '   Copy .env.example to .env and fill in your Cloudflare R2 credentials:',
    );
    for (const m of missing) {
      console.error(`   ${m}=xxxxxxxx`);
    }
    process.exit(1);
  }
}
