// Renderer-side global declaration for the preload bridge.
//
// The preload script (`src/preload/index.ts`) installs the typed
// `DesktopApi` object on the renderer's `window` via
// `contextBridge.exposeInMainWorld('desktop', api)`. This module
// declaration teaches the renderer's TypeScript program about that
// runtime fact so application code can write `window.desktop.*`
// without `as` casts or `// @ts-expect-error` workarounds.
//
// The declaration is `import type`-only at the top level — we import
// the contract from `src/main/types.ts` purely as a type. Combined
// with `isolatedModules: true` (see `tsconfig.base.json`), this
// guarantees the renderer bundle picks up zero runtime code from
// `src/main`, preserving the sandbox boundary.
//
// `tsconfig.renderer.json` includes `src/renderer/**/*.ts` (which
// matches `*.d.ts` siblings), so this file is picked up
// automatically; no manual `types` array entry is required.

import type { DesktopApi } from '../../main/types';

declare global {
  interface Window {
    /**
     * Typed bridge surface installed by `src/preload/index.ts`.
     *
     * Marked optional because the renderer can be rendered in
     * environments where the preload script has not run (e.g. unit
     * tests under `vitest` with a jsdom environment). Production
     * code that depends on `window.desktop` must guard for
     * `undefined` and surface a useful error.
     */
    readonly desktop?: DesktopApi;
  }
}

// Ensure this file is treated as a module so the `declare global`
// block augments rather than redeclares `Window`.
export {};
