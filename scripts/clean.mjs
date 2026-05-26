// Removes the build output directory before a fresh `npm run build`.
// Uses node's built-in fs.rm so we don't depend on `rimraf` being hoisted.

import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

await rm(distDir, { recursive: true, force: true });
