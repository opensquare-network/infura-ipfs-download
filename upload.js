import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadDirectory } from './src/upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const folderName = process.argv[2];

if (!folderName) {
  console.error(
    '❌ Please specify a folder name under downloads/.\n' +
      '   Usage: node upload.js <folder-name>\n' +
      '   Example: pnpm run upload my-project',
  );
  process.exit(1);
}

const dirPath = path.join(__dirname, 'downloads', folderName);

uploadDirectory(dirPath).catch((err) => {
  console.error('\n💥 Unexpected error:', err.message);
  process.exit(1);
});
