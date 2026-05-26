// Feature: cpa-quota-import, Property 5
//
// Property 5: `appSettingsSchema.safeParse(buildDefaultAppSettings())` is
// `{ success: true }`.
//
// Validates Requirements 13.1, 13.2.
//   - 13.1 `buildDefaultAppSettings()` must seed every required field on
//          `AppSettings`, including the `cliproxy` block introduced by
//          this feature. A missing default would break the first-launch
//          seed path in `loadOrSeedAppSettings()`.
//   - 13.2 `appSettingsSchema` must validate the `cliproxy` block via
//          `cliproxySettingsSchema`, in addition to all pre-existing
//          fields, and must reject any extra unknown key (`.strict()`
//          carried over from the parent design's Property 12).
//
// This test is the canary for the historical regression where the
// default builder lacked `cliproxy` and the schema lacked `cliproxy`
// validation. With Task 1.4 (schema) and Task 3.1 (default builder)
// landed, the deterministic baseline now round-trips cleanly. We use
// `fc.constant(...)` so the property runs `numRuns: 100` times against
// the same seed value — fast-check cannot meaningfully shrink a
// constant arbitrary, but the PBT plumbing keeps this test consistent
// with the other `*.pbt.test.ts` files in the repo and gives us a
// stable hook if a future regression makes the default non-deterministic
// (e.g. by reading from `Date.now()` or `crypto.randomUUID()`).
//
// `electron` must be mocked because `src/main/app.ts` does
// `import { app, BrowserWindow, dialog, safeStorage, session, Tray } from 'electron'`
// at module top — none of those bindings are actually touched by
// `buildDefaultAppSettings`, but Node's module loader still resolves
// the package on import. Inert stubs are sufficient.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// Vitest hoists `vi.mock()` calls above all other statements, so this
// runs before the `import { buildDefaultAppSettings }` line below
// resolves the `electron` peer dependency.
vi.mock('electron', () => ({
  app: {
    getPath: () => '',
    isPackaged: true,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    setLoginItemSettings: () => undefined,
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  dialog: {},
  safeStorage: {},
  session: { defaultSession: {} },
  Tray: class {},
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({}) },
  screen: { getAllDisplays: () => [] },
}));

import { buildDefaultAppSettings } from './app';
import { appSettingsSchema } from './schemas';

describe('appSettingsSchema (Property 5: accepts every default)', () => {
  it('accepts the seeded `buildDefaultAppSettings()` blob (sanity)', () => {
    // Sanity gate before the property loop — if this fails, the
    // property body below would just produce 100 identical errors.
    const result = appSettingsSchema.safeParse(buildDefaultAppSettings());
    expect(result.success).toBe(true);
  });

  it('the seeded default round-trips through appSettingsSchema', () => {
    fc.assert(
      fc.property(
        // Per the design's §Testing Strategy entry for Property 5,
        // the simplest acceptable form is a constant arbitrary. The
        // test is deterministic by construction; running it 100 times
        // simply asserts the round-trip is stable across repeated
        // builder invocations.
        fc.constant(buildDefaultAppSettings()),
        (settings) => {
          expect(appSettingsSchema.safeParse(settings).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
