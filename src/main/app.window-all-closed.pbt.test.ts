// Feature: macos-platform-support, Property 12: `window-all-closed` never calls `app.quit`
//
// Validates: Requirement 8.3
//
// **What this property pins down.**
//
//   For every `platform ∈ {'win32', 'darwin', 'linux'}`, firing the
//   `window-all-closed` event on the live `app` instance MUST NOT
//   trigger `app.quit()`. The application's lifecycle is owned by
//   the tray's "退出" entry exclusively; the OS-emitted close-cascade
//   on the last window must leave the process alive in the menu
//   bar / system tray on every supported platform.
//
// **How we drive it.** We mock `electron`. The mock's `app.on(event, cb)`
// records callbacks per event name, and `app.quit` is a vitest spy.
// Each iteration:
//
//   1. Pin `process.platform` to the generated platform string.
//   2. Reset modules and the spy so the case is independent of its
//      predecessors.
//   3. Re-import `./app` and invoke `main()` so `handleWindowAllClosed`
//      gets registered on the mocked `app`.
//   4. Fire every `window-all-closed` listener captured by the mock.
//   5. Assert the `app.quit` spy was never called.
//
// **Why all three platforms.** Requirement 8.3 reads "THE App SHALL
// NOT call `app.quit()`" without a platform qualifier, so the
// invariant holds universally. Generating from a 3-element constant
// gives fast-check 100 iterations of fully-independent cases (the
// shrinker has nothing to shrink to once a counterexample is
// found, so failures land with a clean platform value).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Electron mock
// ---------------------------------------------------------------------------
//
// `app.on(event, cb)` records callbacks per event name so the test
// can fire them deterministically. `app.quit` is a spy so the
// property assertion has a single clean predicate to read.

interface MockState {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  quit: ReturnType<typeof vi.fn>;
}

const mockState: MockState = {
  listeners: new Map(),
  quit: vi.fn(),
};

function resetMockState(): void {
  mockState.listeners.clear();
  mockState.quit.mockReset();
}

vi.mock('electron', () => ({
  app: {
    on: (event: string, cb: (...args: unknown[]) => void) => {
      const list = mockState.listeners.get(event) ?? [];
      list.push(cb);
      mockState.listeners.set(event, list);
    },
    quit: (...args: unknown[]) => mockState.quit(...args),
    isReady: () => true,
    isPackaged: true,
    // `whenReady` returns a never-resolving promise so `boot()` is
    // never invoked. We only care about the lifecycle listeners
    // registered by `main()`, not the heavy DB / scheduler / IPC
    // setup that runs inside `boot`.
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
// process.platform pinning
// ---------------------------------------------------------------------------

function pinPlatform(value: string): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
  return () => {
    Object.defineProperty(process, 'platform', {
      value: original,
      configurable: true,
    });
  };
}

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

const platformArb = fc.constantFrom('win32', 'darwin', 'linux');

describe('Property 12: window-all-closed never calls app.quit', () => {
  beforeEach(() => {
    resetMockState();
    vi.resetModules();
  });

  it('on every supported platform, firing window-all-closed leaves app.quit untouched', async () => {
    await fc.assert(
      fc.asyncProperty(platformArb, async (platform) => {
        // Per-iteration setup: fresh module graph, fresh mocked
        // listener map, fresh `quit` spy, freshly-pinned platform.
        resetMockState();
        vi.resetModules();
        const restorePlatform = pinPlatform(platform);
        try {
          // Re-import `./app` after the mock + module reset so the
          // freshly-imported module wires its `window-all-closed`
          // handler against the freshly-cleared listener map.
          const { main } = await import('./app');
          main();

          // The `idempotent guard` inside `main` prevents a second
          // call from re-registering listeners. We did `vi.resetModules`
          // above, so this `main()` is the first call on this module
          // instance and the registration runs.
          const listeners =
            mockState.listeners.get('window-all-closed') ?? [];
          expect(listeners.length).toBeGreaterThanOrEqual(1);

          // Fire every captured listener. None of them may call
          // `app.quit()` per Requirement 8.3.
          for (const cb of listeners) {
            cb();
          }

          expect(mockState.quit).not.toHaveBeenCalled();
        } finally {
          restorePlatform();
        }
      }),
      { numRuns: 100 },
    );
  });
});
