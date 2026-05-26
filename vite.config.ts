import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite is the renderer-only bundler. Main + preload are emitted by `tsc`
// (see `tsconfig.main.json` and `npm run build`).
//
// `base: './'` keeps asset paths relative so the production renderer can be
// loaded via `file://` from `dist/renderer/index.html` inside Electron.
//
// The renderer entry is `src/renderer/index.html` (Vite treats `root` as the
// HTML entry directory). Output goes to `<workspace>/dist/renderer`.
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome128',
  },
});
