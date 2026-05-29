// Autostart manager unit tests.
//
// Validates Requirements 9.4, 9.6 from macos-platform-support spec:
//   - 9.4: identical TypeScript signatures across darwin/win32/linux,
//          with no `process.platform` branching at the
//          `setLoginItemSettings` / `getLoginItemSettings` call sites.
//   - 9.6: errors from `app.setLoginItemSettings` propagate to the caller
//          unchanged, and a subsequent `getAutostart()` reflects the
//          actual current OS Login Items state.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level state shared with the mocked `electron` module so each
// test can configure how `app.setLoginItemSettings` behaves.
const electronState: {
  loginItem: { openAtLogin: boolean };
  setShouldThrow: Error | null;
} = {
  loginItem: { openAtLogin: false },
  setShouldThrow: null,
};

vi.mock('electron', () => ({
  app: {
    setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
      if (electronState.setShouldThrow !== null) {
        throw electronState.setShouldThrow;
      }
      electronState.loginItem = { openAtLogin: settings.openAtLogin };
    },
    getLoginItemSettings: () => electronState.loginItem,
  },
}));

// Import after the mock is registered so the autostart module sees the
// mocked `electron` module surface.
import { setAutostart, getAutostart } from './autostart';

describe('autostart', () => {
  beforeEach(() => {
    electronState.loginItem = { openAtLogin: false };
    electronState.setShouldThrow = null;
  });

  describe('setAutostart', () => {
    it('enables login item registration', () => {
      setAutostart(true);
      expect(getAutostart()).toBe(true);
    });

    it('disables login item registration', () => {
      setAutostart(true);
      setAutostart(false);
      expect(getAutostart()).toBe(false);
    });

    // Requirement 9.6: thrown errors propagate to the caller unchanged.
    it('propagates errors from setLoginItemSettings unchanged', () => {
      const boom = new Error('login items unavailable');
      electronState.setShouldThrow = boom;

      expect(() => setAutostart(true)).toThrowError(boom);
    });

    // Requirement 9.6: after a throw, subsequent getAutostart() reflects
    // the actual current OS state, not a cached or assumed value.
    it('reflects actual OS state in getAutostart() after a throw', () => {
      // Pre-condition: the OS reports the user is not registered.
      electronState.loginItem = { openAtLogin: false };

      const boom = new Error('keychain locked');
      electronState.setShouldThrow = boom;

      // Caller asks to enable. The Electron call throws, the wrapper
      // does not catch it.
      expect(() => setAutostart(true)).toThrow(boom);

      // The OS state was not mutated by the failed call. getAutostart()
      // returns whatever the OS actually reports.
      expect(getAutostart()).toBe(false);

      // Now simulate the OS state changing out-of-band (e.g. another
      // process registered the login item). getAutostart() must report
      // the live OS value, never a cached one.
      electronState.loginItem = { openAtLogin: true };
      expect(getAutostart()).toBe(true);
    });
  });

  describe('getAutostart', () => {
    it('returns the current openAtLogin flag from Electron', () => {
      electronState.loginItem = { openAtLogin: true };
      expect(getAutostart()).toBe(true);

      electronState.loginItem = { openAtLogin: false };
      expect(getAutostart()).toBe(false);
    });
  });

  // Requirement 9.4: no `process.platform` branching at the call sites
  // of `setLoginItemSettings` / `getLoginItemSettings`. We enforce this
  // by static source inspection so a future refactor that re-introduces
  // a platform branch fails CI.
  describe('source-level invariants (Requirement 9.4)', () => {
    const sourcePath = path.resolve(__dirname, 'autostart.ts');
    const source = readFileSync(sourcePath, 'utf8');

    // Strip line comments and block comments so the static check is
    // not tripped by documentation references.
    const sourceWithoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    it('contains no process.platform reference outside comments', () => {
      expect(sourceWithoutComments).not.toMatch(/process\.platform/);
    });

    it('calls setLoginItemSettings without surrounding platform branch', () => {
      // The call must appear inside `setAutostart` without any
      // `if (process.platform...)` gate immediately above it. We
      // simply assert the call exists and the file contains no
      // platform check — taken together this satisfies the requirement.
      expect(sourceWithoutComments).toMatch(/app\.setLoginItemSettings\(/);
      expect(sourceWithoutComments).toMatch(/app\.getLoginItemSettings\(/);
    });
  });
});
