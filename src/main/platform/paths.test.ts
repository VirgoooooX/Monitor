// Regression-locked example tests for the per-platform path resolvers.
//
// Validates: Requirement 13.3 — Windows behaviour preserved.
//
// These cases pin the exact win32 outputs that the pre-feature
// `antigravity.collector.ts` and `opencode.collector.ts` produced
// when `process.env.APPDATA === 'C:\\Users\\test\\AppData\\Roaming'`.
// If a future refactor changes the separator flavour, the trailing
// segments, or the AppData-relative anchor on Windows, this file
// fails immediately — independently of the property-based test in
// `paths.pbt.test.ts`.
//
// We assert byte-for-byte equality (no `toContain`, no `toMatch`) so
// the regression lock catches even seemingly-trivial changes such as
// a stray trailing slash or a substituted segment.

import { describe, it, expect } from 'vitest';

import {
  resolveAntigravityAppDataPath,
  resolveOpencodePath,
} from './paths';

describe('resolveAntigravityAppDataPath — win32 regression lock', () => {
  it('returns the exact pre-feature path when APPDATA is set', () => {
    const result = resolveAntigravityAppDataPath(
      'win32',
      { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      'C:\\Users\\test',
    );
    expect(result).toBe(
      'C:\\Users\\test\\AppData\\Roaming\\Antigravity\\logs',
    );
  });

  it('falls back to <homedir>\\AppData\\Roaming when APPDATA is absent', () => {
    const result = resolveAntigravityAppDataPath(
      'win32',
      {},
      'C:\\Users\\test',
    );
    expect(result).toBe(
      'C:\\Users\\test\\AppData\\Roaming\\Antigravity\\logs',
    );
  });
});

describe('resolveOpencodePath — win32 regression lock', () => {
  it('returns the exact pre-feature path when APPDATA is set', () => {
    const result = resolveOpencodePath(
      'win32',
      { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      'C:\\Users\\test',
    );
    expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\opencode');
  });

  it('falls back to <homedir>\\AppData\\Roaming when APPDATA is absent', () => {
    const result = resolveOpencodePath('win32', {}, 'C:\\Users\\test');
    expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\opencode');
  });
});
