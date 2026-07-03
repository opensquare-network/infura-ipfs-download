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
