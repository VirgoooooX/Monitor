// Feature: macos-platform-support, Property 8: compact-window zoom is finite and clamped
//
// Validates: Requirements 7.5, 7.5a, 7.5b
//
// **What this property pins down.**
//
//   For any persisted `appearance.compactZoom` value — whether a
//   finite number, a non-finite number (`NaN`, `±Infinity`),
//   `undefined`, `null`, a string, or an arbitrary object —
//   `clampCompactZoom` produces a value that:
//
//     1. Is a finite number (no `NaN`, no `±Infinity`).
//     2. Lies in the closed interval `[0.1, 2.0]`.
//     3. Equals `1.0` when the input is non-finite or non-numeric
//        (Requirement 7.5b: the substituted default before the
//        clamp is applied).
//     4. Equals `min(2.0, max(0.1, raw))` when the input is a
//        finite `number` (Requirement 7.5a: the spec's clamp
//        formula applied after the substitution).
//
// **Purity.** `clampCompactZoom` reads only its argument; no
// `process`, no `_settings`, no globals. The PBT body therefore
// drives it directly with raw fast-check generators and expects
// deterministic output for every iteration.
//
// **Why the value-class generators are split.** Mixing finite and
// non-finite arms inside a single `fc.oneof` would still be
// correct, but separating the finite branch lets fast-check shrink
// to the simplest counter-example for the clamp arithmetic
// (Requirement 7.5a) without first having to rule out the
// non-numeric branch (Requirement 7.5b). Two named arms make
// failure messages precise.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// `electron` must be mocked because `src/main/app.ts` imports
// `{ app, BrowserWindow, dialog, safeStorage, session, Tray, ... }`
// at module top — none of those bindings are touched by
// `clampCompactZoom`, but Node's module loader still resolves the
// package on import. Inert stubs are sufficient. Mirrors the
// pattern already established in `tray.pbt.test.ts`.
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

import { clampCompactZoom } from './app';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const COMPACT_MIN_ZOOM = 0.1;
const COMPACT_MAX_ZOOM = 2.0;

/**
 * Finite-number arm: covers the clamp arithmetic.
 *
 * `fc.float()` with `noNaN: true` and `noDefaultInfinity: true`
 * yields finite 32-bit floats. The range is intentionally wider
 * than `[0.1, 2.0]` so the property exercises both clamp
 * boundaries and the interior pass-through. Single-precision
 * floats are sufficient because `Math.min` / `Math.max` operate on
 * IEEE-754 64-bit doubles, and every 32-bit float upcasts losslessly.
 */
const finiteNumberArb: fc.Arbitrary<number> = fc.float({
  min: -1e6,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * Non-finite / non-numeric arm: covers the `1.0` substitution.
 *
 * Includes the four magic numbers the spec calls out by name
 * (`NaN`, `Infinity`, `-Infinity`, `undefined`, `null`), plus an
 * arbitrary string and an arbitrary object so the predicate
 * `typeof raw === 'number' && Number.isFinite(raw)` is exercised
 * across every branch a JSON round-trip could produce.
 */
const nonNumericArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(NaN, Infinity, -Infinity, undefined, null),
  fc.string(),
  fc.object(),
);

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

describe('Property 8: compact-window zoom is finite and clamped', () => {
  it('finite numbers clamp into [0.1, 2.0] via min(2, max(0.1, raw))', () => {
    fc.assert(
      fc.property(finiteNumberArb, (raw) => {
        const result = clampCompactZoom(raw);

        // (1) finite
        expect(Number.isFinite(result)).toBe(true);
        // (2) in [0.1, 2.0]
        expect(result).toBeGreaterThanOrEqual(COMPACT_MIN_ZOOM);
        expect(result).toBeLessThanOrEqual(COMPACT_MAX_ZOOM);
        // (4) equals the spec's clamp formula
        expect(result).toBe(
          Math.min(COMPACT_MAX_ZOOM, Math.max(COMPACT_MIN_ZOOM, raw)),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('non-finite / non-numeric values collapse to 1.0 before clamp', () => {
    fc.assert(
      fc.property(nonNumericArb, (raw) => {
        const result = clampCompactZoom(raw);

        // (1) finite
        expect(Number.isFinite(result)).toBe(true);
        // (2) in [0.1, 2.0]
        expect(result).toBeGreaterThanOrEqual(COMPACT_MIN_ZOOM);
        expect(result).toBeLessThanOrEqual(COMPACT_MAX_ZOOM);
        // (3) substituted default before clamp — `1.0` is in range
        // so the clamp is a no-op and the final value is exactly `1`.
        expect(result).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it('combined arm: every value class yields a finite number in [0.1, 2.0]', () => {
    // Belt-and-braces guard that pins the cross-arm invariant — no
    // matter the input class, the output is finite and in range.
    // Useful as a single shrink target if (1)/(2) ever diverge.
    fc.assert(
      fc.property(
        fc.oneof(finiteNumberArb, nonNumericArb),
        (raw) => {
          const result = clampCompactZoom(raw);
          expect(Number.isFinite(result)).toBe(true);
          expect(result).toBeGreaterThanOrEqual(COMPACT_MIN_ZOOM);
          expect(result).toBeLessThanOrEqual(COMPACT_MAX_ZOOM);
        },
      ),
      { numRuns: 100 },
    );
  });
});
