// Feature: macos-platform-support, Property 6: tray icon resolver — per-platform correct without conditional skipping
//
// Validates: Requirements 5.4, 5.5, 5.6, 12.6, 13.4
//
// **What this property pins down.**
//
//   For any `platform ∈ {'win32', 'darwin', 'linux'}` and any
//   non-empty `resourcesRoot`, `resolveTrayIconPath`:
//
//     1. Returns a non-empty string (total).
//     2. Never throws.
//     3. Final path segment is `tray-iconTemplate.png` on darwin and
//        `tray-icon.png` on every other platform — Requirements 5.4
//        / 5.5 / 12.6.
//     4. The result is rooted at the supplied `resourcesRoot` —
//        i.e. `<resourcesRoot>/<finalSegment>`. Asserted against the
//        spec's expected join, NOT against substring predicates,
//        so a future change to the segment list (e.g. a new sub-
//        directory under Resources) makes the property fail with a
//        precise counter-example rather than silently passing.
//
// **No global mutation.** The resolver takes `platform` and
// `resourcesRoot` as plain string arguments; the property body never
// reads or writes `process.platform`, `process.resourcesPath`, or
// any other global. The Property 1 / 2 PBT tests already cover the
// purity-trap pattern for the path-resolver layer; the tray icon
// resolver lives in `app.ts` next to a non-pure
// `resolveTrayResourcesRoot` helper, so we test only the pure half
// here. Requirement 12.6 / 13.4.
//
// **Why we exercise linux explicitly.** Requirement 12.6 demands
// that linux gets a property-test branch without `it.skipIf` or
// equivalent conditional skipping. The non-darwin branch handles
// win32 + linux + any unrecognised string identically, so we can
// give all three the same expected output and let fast-check
// shrink to the simplest counter-example if the implementation
// ever diverges.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import * as path from 'node:path';

// `electron` must be mocked because `src/main/app.ts` does
// `import { app, BrowserWindow, dialog, safeStorage, session, Tray } from 'electron'`
// at module top — none of those bindings are actually touched by
// `resolveTrayIconPath`, but Node's module loader still resolves the
// package on import. Inert stubs are sufficient. Mirrors the pattern
// already established in `schemas.app-defaults.pbt.test.ts`.
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

import { resolveTrayIconPath } from './app';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Three real platforms — Requirement 12.6 mandates all three are
 * exercised without conditional skipping. We deliberately do NOT
 * include the empty string here because Requirement 5.5 only speaks
 * to the three named platforms; the resolver still folds unknown
 * platforms into the colour-icon branch (covered by `linux` here),
 * but the spec's per-platform mapping is what this property locks.
 */
const platformArb = fc.constantFrom('win32', 'darwin', 'linux');

/**
 * Non-empty `resourcesRoot` constrained to plausible filesystem
 * shapes. We reuse the same null-byte filter Property 1 / 2 use so
 * `path.join` doesn't reject the input with `ERR_INVALID_ARG_VALUE`
 * — the resolver is not required to defend against null bytes, and
 * a stray null in the generator would surface as a false positive.
 */
const resourcesRootArb = fc
  .string({ minLength: 1, maxLength: 260 })
  .filter((s) => !s.includes('\u0000'));

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

/**
 * Independent, fully-spelled-out reference implementation of the
 * spec. If a future refactor changes the implementation in `app.ts`
 * (e.g. by switching to `path.posix.join` or by adding a sub-folder
 * under Resources), this model still mirrors the spec branches
 * one-for-one, so the property failure pinpoints the divergence.
 */
function modelTrayIconPath(platform: string, resourcesRoot: string): string {
  const finalSegment =
    platform === 'darwin' ? 'tray-iconTemplate.png' : 'tray-icon.png';
  return path.join(resourcesRoot, finalSegment);
}

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

describe('Property 6: resolveTrayIconPath — per-platform correct without conditional skipping', () => {
  it('returns the correct asset filename per platform, rooted at the supplied resourcesRoot', () => {
    fc.assert(
      fc.property(
        platformArb,
        resourcesRootArb,
        (platform, resourcesRoot) => {
          const result = resolveTrayIconPath(platform, resourcesRoot);

          // (1) non-empty string
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);

          // (3) final segment per platform
          const segments = result.split(/[\\/]/g).filter((s) => s.length > 0);
          const finalSegment = segments[segments.length - 1];
          if (platform === 'darwin') {
            expect(finalSegment).toBe('tray-iconTemplate.png');
          } else {
            expect(finalSegment).toBe('tray-icon.png');
          }

          // (4) per-spec model equality — subsumes the rooting
          // check.
          expect(result).toBe(modelTrayIconPath(platform, resourcesRoot));
        },
      ),
      { numRuns: 100 },
    );
  });
});
