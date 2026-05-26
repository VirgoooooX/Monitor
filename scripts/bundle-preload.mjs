// Bundle the preload script into a single file using esbuild.
//
// Electron's sandbox mode does not allow `require()` of relative
// modules in preload scripts. The only allowed require is 'electron'.
// This script bundles dist/preload/index.js (tsc output) into a
// self-contained file that inlines all relative imports while keeping
// 'electron' as an external.

import { build } from 'esbuild';

await build({
  entryPoints: ['dist/preload/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/preload/index.js',
  allowOverwrite: true,
  external: ['electron'],
  format: 'cjs',
  sourcemap: true,
});

console.log('✓ dist/preload/index.js bundled for sandbox');
