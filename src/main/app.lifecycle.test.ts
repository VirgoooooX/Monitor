// Feature: macos-platform-support, Task 8.2 — lifecycle handlers
//
// Validates: Requirements 8.4, 8.5, 8.6, 8.7.
//
// Four invariants under test:
//
//   - 8.5: `before-quit` flag is observable from a second listener
//          registered after the application's. We capture every
//          callback registered through `app.on('before-quit', ...)`
//          via the electron mock, register the application's flag
//          flipper through the dedicated test helper exported from
//          `./app`, then register a *second* listener and fire all
//          listeners in registration order. The second listener
//          must observe `isAppQuitting() === true` synchronously.
//
//   - 8.4: `handleActivate` recreates a destroyed compact window
//          and shows a hidden one. We can't drive the private
//          `handleActivate` directly without booting the full app,
//          so we enforce the contract via static source inspection
//          on the `handleActivate` function body — the same
//          line-based slicing technique used by
//          `tray.no-platform-branch.test.ts` (Requirement 5.6).
//
//   - 8.6: no `app.dock.hide()` / `app.dock.show()` references
//          anywhere in `app.ts`. Static source check.
//
//   - 8.7: the expanded-window open path calls `focus()` AND
//          `moveTop()`. We assert two source-level invariants on
//          `openOrFocusExpanded`: (a) the existing-window branch
//          calls both methods on `_expandedWindow`; (b) the
//          create-new-window branch installs a `ready-to-show`
//          listener that calls both methods on the freshly
//          created window. The runtime mock-driven path is
//          covered indirectly by the existing
//          `windows.darwin-posture.test.ts` setup; here we lock
//          the call sites so a future refactor that drops one of
//          the calls fails CI.
//
// Source-level checks read `app.ts` directly. They are line-based
// (no AST parse) and tolerate CRLF / LF differences. The same
// pattern is used by `tray.no-platform-branch.test.ts`.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const APP_SOURCE_PATH = path.join(__dirname, 'app.ts');

// ---------------------------------------------------------------------------
// Electron mock — captures every `before-quit` listener so the test
// can fire them in registration order.
// ---------------------------------------------------------------------------

interface MockState {
  beforeQuitListeners: Array<() => void>;
}

const mockState: MockState = {
  beforeQuitListeners: [],
};

function resetMockState(): void {
  mockState.beforeQuitListeners.length = 0;
}

vi.mock('electron', () => ({
  app: {
    on: (event: string, cb: () => void) => {
      if (event === 'before-quit') {
        mockState.beforeQuitListeners.push(cb);
      }
    },
    quit: () => undefined,
    isReady: () => true,
    isPackaged: true,
    whenReady: () => new Promise(() => undefined),
    setLoginItemSettings: () => undefined,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    getPath: () => '',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  dialog: { showErrorBox: () => undefined },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
  Tray: class {},
  nativeImage: { createFromPath: () => ({}) },
  safeStorage: {},
  session: { defaultSession: {} },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
  screen: { getAllDisplays: () => [] },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Requirement 8.5: before-quit flag is observable from a second listener', () => {
  beforeEach(async () => {
    resetMockState();
    vi.resetModules();
    // Reset the module-level `_isQuitting` flag on the freshly-
    // imported module so the case starts from a clean state.
    const mod = await import('./app');
    mod.__resetIsQuittingForTests();
  });

  it('registers the flag flipper, then a second listener observes the flipped flag', async () => {
    const { __registerBeforeQuitFlagFlipper, isAppQuitting } = await import(
      './app'
    );

    // Pre-condition: flag is `false` before any listener fires.
    expect(isAppQuitting()).toBe(false);

    // Register the application's flag flipper (this is what `boot`
    // does at step 0).
    __registerBeforeQuitFlagFlipper();
    expect(mockState.beforeQuitListeners).toHaveLength(1);

    // Register a SECOND listener after the application's. The
    // second listener captures the value of `isAppQuitting()` at
    // the moment it runs — that is the value the spec says must
    // already be `true`.
    let observedByLateListener: boolean | null = null;
    const lateListener = (): void => {
      observedByLateListener = isAppQuitting();
    };
    // Re-use the same Electron mock surface a real registration
    // would touch, so the test's late listener sits in the same
    // chain as the application's flag flipper.
    const { app: mockedApp } = await import('electron');
    mockedApp.on('before-quit', lateListener);

    expect(mockState.beforeQuitListeners).toHaveLength(2);

    // Fire the listeners in registration order (Electron's
    // documented semantics — first registered, first fired). The
    // application's flag flipper runs first, the late listener
    // runs second and reads the post-flip value.
    for (const cb of mockState.beforeQuitListeners) {
      cb();
    }

    // The late listener observed the flipped flag.
    expect(observedByLateListener).toBe(true);
    // And the global getter still reports `true` after the chain.
    expect(isAppQuitting()).toBe(true);
  });

  it('flag is monotonic: re-firing before-quit keeps it at true', async () => {
    const { __registerBeforeQuitFlagFlipper, isAppQuitting } = await import(
      './app'
    );

    __registerBeforeQuitFlagFlipper();
    mockState.beforeQuitListeners[0]?.();
    expect(isAppQuitting()).toBe(true);

    // A second invocation of the same listener keeps the flag at
    // `true` (monotonic transition; the spec only requires the
    // post-first-call observation).
    mockState.beforeQuitListeners[0]?.();
    expect(isAppQuitting()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source-level static checks
// ---------------------------------------------------------------------------

/**
 * Extract the body of a top-level `function NAME(...)` declaration
 * by string slicing. Returns the substring between the first `{` of
 * the declaration and the matching closing `}` at column zero. The
 * project's formatter places top-level closing braces at column zero,
 * so we can match without a brace-depth tracker.
 */
function extractFunctionBody(source: string, name: string): string {
  const normalised = source.replace(/\r\n/g, '\n');
  const startMarker = `function ${name}(`;
  const startIdx = normalised.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error(`app.ts: could not locate function ${name}`);
  }
  const openBraceIdx = normalised.indexOf('{', startIdx);
  if (openBraceIdx < 0) {
    throw new Error(`app.ts: could not locate body of ${name}`);
  }
  let cursor = openBraceIdx + 1;
  while (cursor < normalised.length) {
    const nextClose = normalised.indexOf('\n}', cursor);
    if (nextClose === -1) {
      throw new Error(
        `app.ts: could not locate closing brace of ${name}`,
      );
    }
    const after = normalised.charAt(nextClose + 2);
    if (after === '\n' || after === '') {
      return normalised.slice(openBraceIdx + 1, nextClose);
    }
    cursor = nextClose + 2;
  }
  throw new Error(`app.ts: could not locate closing brace of ${name}`);
}

/** Strip block + line comments so the static checks ignore prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('Requirement 8.6: no app.dock.hide() / app.dock.show() in app.ts', () => {
  it('app.ts contains no app.dock.hide / app.dock.show references outside comments', () => {
    const source = readFileSync(APP_SOURCE_PATH, 'utf-8');
    const code = stripComments(source);

    expect(code).not.toMatch(/\bapp\.dock\.hide\b/);
    expect(code).not.toMatch(/\bapp\.dock\.show\b/);
    // Defence-in-depth: any reference to `app.dock` under any
    // method name is an unexpected mac-only Dock posture call.
    // The codebase is supposed to rely on `LSUIElement = true`
    // exclusively (Requirement 8.1, design.md §Decision 7).
    expect(code).not.toMatch(/\bapp\.dock\b/);
  });
});

describe('Requirement 8.4: handleActivate has explicit show / recreate branches', () => {
  it('handleActivate body contains both `.show()` (existing) and createCompactWindow (recreate) call sites', () => {
    const source = readFileSync(APP_SOURCE_PATH, 'utf-8');
    const body = extractFunctionBody(source, 'handleActivate');
    const code = stripComments(body);

    // Existing-and-alive branch: must call `.show()` on the live
    // compact window handle. We accept any whitespace between
    // `_compactWindow` and `.show(`.
    expect(code).toMatch(/_compactWindow\s*\.\s*show\s*\(\s*\)/);

    // Destroyed-or-missing branch: must call createCompactWindow
    // to materialise a fresh window.
    expect(code).toMatch(/createCompactWindow\s*\(/);

    // The existing-window branch must also probe `isDestroyed()`
    // before calling `.show()` — Requirement 8.4 says recreate
    // when the window has been destroyed.
    expect(code).toMatch(/isDestroyed\s*\(\s*\)/);
  });
});

describe('Requirement 8.7: openOrFocusExpanded calls focus() and moveTop()', () => {
  it('existing-window branch calls both `_expandedWindow.focus()` and `_expandedWindow.moveTop()`', () => {
    const source = readFileSync(APP_SOURCE_PATH, 'utf-8');
    const body = extractFunctionBody(source, 'openOrFocusExpanded');
    const code = stripComments(body);

    // The existing-window branch is the prefix of the function up
    // to (and including) the early `return;`. We slice on the first
    // occurrence of `return;` so a future addition of a `return;`
    // inside the create branch does not change the slice.
    const earlyReturnIdx = code.indexOf('return;');
    expect(earlyReturnIdx).toBeGreaterThan(0);
    const existingBranch = code.slice(0, earlyReturnIdx);

    expect(existingBranch).toMatch(/_expandedWindow\s*\.\s*focus\s*\(\s*\)/);
    expect(existingBranch).toMatch(
      /_expandedWindow\s*\.\s*moveTop\s*\(\s*\)/,
    );
  });

  it('create-window branch wires focus() and moveTop() through a ready-to-show listener', () => {
    const source = readFileSync(APP_SOURCE_PATH, 'utf-8');
    const body = extractFunctionBody(source, 'openOrFocusExpanded');
    const code = stripComments(body);

    // Slice the create-window branch — everything after the early
    // `return;` of the existing-window short-circuit.
    const earlyReturnIdx = code.indexOf('return;');
    const createBranch = code.slice(earlyReturnIdx);

    // The freshly-created window's variable name is `expandedWindow`
    // (no underscore prefix). The branch must register a
    // `ready-to-show` listener that calls both `.focus()` and
    // `.moveTop()` on it.
    expect(createBranch).toMatch(
      /expandedWindow\s*\.\s*once\s*\(\s*['"]ready-to-show['"]/,
    );
    expect(createBranch).toMatch(/expandedWindow\s*\.\s*focus\s*\(\s*\)/);
    expect(createBranch).toMatch(/expandedWindow\s*\.\s*moveTop\s*\(\s*\)/);
  });
});

describe('Requirement 8.3: handleWindowAllClosed never calls app.quit()', () => {
  it('handleWindowAllClosed body contains no app.quit() reference', () => {
    const source = readFileSync(APP_SOURCE_PATH, 'utf-8');
    const body = extractFunctionBody(source, 'handleWindowAllClosed');
    const code = stripComments(body);

    expect(code).not.toMatch(/\bapp\.quit\s*\(/);
  });
});
