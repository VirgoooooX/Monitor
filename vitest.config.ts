import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // The renderer-component test suite (network-quick-actions tasks
  // 15.7..15.10) imports `.tsx` source modules from
  // `src/renderer/components/**`. esbuild's loader needs the React
  // plugin to handle the `react-jsx` automatic runtime that the
  // renderer uses (see `tsconfig.renderer.json`).
  plugins: [react()],
  test: {
    // `.tsx` is included so renderer component tests can live next to
    // their components. The default environment stays `node` for
    // performance; renderer specs that need a DOM opt in via the
    // `// @vitest-environment jsdom` file directive at the top of the
    // test file.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    globals: false,
  },
});
