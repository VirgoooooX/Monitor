// Feature: macos-platform-support, Requirements 7.2, 7.3, 7.6, 7.7, 7.8.
//
// Validates: Requirements 7.2, 7.3, 7.6, 7.7, 7.8, 13.5.
//
// `createCompactWindow` must — and only on darwin — call
// `setAlwaysOnTop(true, 'screen-saver')` exactly once and
// `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
// exactly once, both *after* `new BrowserWindow(...)` returns and
// *before* `loadURL` / `loadFile` runs (Requirement 7.2 / 7.3).
//
// On win32 / linux those calls must not happen at all (Requirement 7.6:
// no level argument to `setAlwaysOnTop`, no `setVisibleOnAllWorkspaces`).
//
// The `icon` posture is the mirror image: omitted on darwin
// (Requirement 7.8), present and pointing at `icon.ico` on every
// other platform (Requirement 7.7).
//
// We Electron-mock the entire `electron` module so this test is safe
// to run under vitest's plain Node environment. `process.platform` is
// flipped per-test via `Object.defineProperty` and restored in
// `afterEach`, so no global state leaks between cases.

import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Electron mock
// ---------------------------------------------------------------------------
//
// Each test renews the module registry (`vi.resetModules`) and resets
// the call log on the BrowserWindow stub, so per-test mutations of
// `process.platform` are observed by the freshly-imported `windows.ts`.

interface CallLog {
  /** Names of methods called on the most recently constructed BrowserWindow, in order. */
  methodOrder: string[];
  /** Arguments seen by `setAlwaysOnTop`, one entry per call. */
  setAlwaysOnTopArgs: unknown[][];
  /** Arguments seen by `setVisibleOnAllWorkspaces`, one entry per call. */
  setVisibleOnAllWorkspacesArgs: unknown[][];
  /** Constructor options passed to the most recent `new BrowserWindow(...)`. */
  ctorOptions: Record<string, unknown> | null;
}

function makeFreshLog(): CallLog {
  return {
    methodOrder: [],
    setAlwaysOnTopArgs: [],
    setVisibleOnAllWorkspacesArgs: [],
    ctorOptions: null,
  };
}

const callLog: CallLog = makeFreshLog();

vi.mock('electron', () => {
  class MockBrowserWindow {
    public webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      listeners: vi.fn(() => []),
      removeListener: vi.fn(),
      loadURL: vi.fn(),
    };
    constructor(options: Record<string, unknown>) {
      callLog.ctorOptions = options;
    }
    setAlwaysOnTop(...args: unknown[]): void {
      callLog.methodOrder.push('setAlwaysOnTop');
      callLog.setAlwaysOnTopArgs.push(args);
    }
    setVisibleOnAllWorkspaces(...args: unknown[]): void {
      callLog.methodOrder.push('setVisibleOnAllWorkspaces');
      callLog.setVisibleOnAllWorkspacesArgs.push(args);
    }
    loadURL(..._args: unknown[]): Promise<void> {
      callLog.methodOrder.push('loadURL');
      return Promise.resolve();
    }
    loadFile(..._args: unknown[]): Promise<void> {
      callLog.methodOrder.push('loadFile');
      return Promise.resolve();
    }
    on(..._args: unknown[]): this {
      return this;
    }
    once(..._args: unknown[]): this {
      return this;
    }
    isDestroyed(): boolean {
      return false;
    }
    show(): void {}
    getBounds(): Electron.Rectangle {
      return { x: 0, y: 0, width: 360, height: 40 };
    }
  }

  return {
    app: { isPackaged: false },
    BrowserWindow: MockBrowserWindow,
    screen: { getAllDisplays: () => [] },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: vi.fn(),
        },
      },
    },
  };
});

// ---------------------------------------------------------------------------
// SettingsRepository fake
// ---------------------------------------------------------------------------

interface SettingsRepoFake {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
  keys(): string[];
  entries(): Array<{ key: string; value: unknown }>;
}

function makeSettings(): SettingsRepoFake {
  const store = new Map<string, unknown>();
  return {
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set: <T,>(key: string, value: T) => {
      store.set(key, value);
    },
    remove: (key: string) => {
      store.delete(key);
    },
    keys: () => Array.from(store.keys()).sort(),
    entries: () =>
      Array.from(store.entries()).map(([key, value]) => ({ key, value })),
  };
}

// ---------------------------------------------------------------------------
// process.platform pinning
// ---------------------------------------------------------------------------

function pinPlatform(value: NodeJS.Platform): () => void {
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
// Tests
// ---------------------------------------------------------------------------

describe('createCompactWindow — macOS posture', () => {
  let restorePlatform: (() => void) | null = null;

  beforeEach(() => {
    callLog.methodOrder = [];
    callLog.setAlwaysOnTopArgs = [];
    callLog.setVisibleOnAllWorkspacesArgs = [];
    callLog.ctorOptions = null;
    vi.resetModules();
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = null;
  });

  it('on darwin: setAlwaysOnTop("screen-saver") and setVisibleOnAllWorkspaces fired exactly once each, before loadURL/loadFile, and `icon` is omitted', async () => {
    restorePlatform = pinPlatform('darwin');

    const { createCompactWindow } = await import('./windows');
    createCompactWindow({
      controllerUrl: 'http://192.168.1.1:80',
      settings: makeSettings() as never,
    });

    // Requirement 7.2: setAlwaysOnTop(true, 'screen-saver') exactly once.
    expect(callLog.setAlwaysOnTopArgs).toHaveLength(1);
    expect(callLog.setAlwaysOnTopArgs[0]).toEqual([true, 'screen-saver']);

    // Requirement 7.3: setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) exactly once.
    expect(callLog.setVisibleOnAllWorkspacesArgs).toHaveLength(1);
    expect(callLog.setVisibleOnAllWorkspacesArgs[0]).toEqual([
      true,
      { visibleOnFullScreen: true },
    ]);

    // Both posture calls precede the renderer load (Requirement 7.2 /
    // 7.3 — "after `new BrowserWindow(...)` returns and before
    // `loadURL`/`loadFile`").
    const setTopIdx = callLog.methodOrder.indexOf('setAlwaysOnTop');
    const setVisibleIdx = callLog.methodOrder.indexOf('setVisibleOnAllWorkspaces');
    const loadIdx = callLog.methodOrder.findIndex(
      (m) => m === 'loadURL' || m === 'loadFile',
    );
    expect(setTopIdx).toBeGreaterThanOrEqual(0);
    expect(setVisibleIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(setTopIdx).toBeLessThan(loadIdx);
    expect(setVisibleIdx).toBeLessThan(loadIdx);

    // Requirement 7.8: `icon` is omitted entirely from the
    // BrowserWindowConstructorOptions on darwin.
    expect(callLog.ctorOptions).not.toBeNull();
    expect(callLog.ctorOptions).not.toHaveProperty('icon');

    // Requirement 7.1: cross-platform invariants preserved.
    expect(callLog.ctorOptions).toMatchObject({
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
    });
  });

  it('on win32: no setAlwaysOnTop/setVisibleOnAllWorkspaces calls, and `icon` resolves to icon.ico', async () => {
    restorePlatform = pinPlatform('win32');

    const { createCompactWindow } = await import('./windows');
    createCompactWindow({
      controllerUrl: 'http://192.168.1.1:80',
      settings: makeSettings() as never,
    });

    // Requirement 7.6: no setAlwaysOnTop level call, no
    // setVisibleOnAllWorkspaces call on non-darwin.
    expect(callLog.setAlwaysOnTopArgs).toHaveLength(0);
    expect(callLog.setVisibleOnAllWorkspacesArgs).toHaveLength(0);

    // Requirement 7.7: `icon` field is set and points at icon.ico
    // (the mock has `app.isPackaged = false`, so the dev-mode branch
    // resolves to `<projectRoot>/build/icon.ico`).
    expect(callLog.ctorOptions).not.toBeNull();
    const icon = callLog.ctorOptions!['icon'];
    expect(typeof icon).toBe('string');
    expect((icon as string).endsWith(`${path.sep}icon.ico`)).toBe(true);

    // Requirement 7.1: cross-platform invariants preserved.
    expect(callLog.ctorOptions).toMatchObject({
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
    });
  });

  it('on linux: no setAlwaysOnTop/setVisibleOnAllWorkspaces calls, and `icon` resolves to icon.ico', async () => {
    restorePlatform = pinPlatform('linux');

    const { createCompactWindow } = await import('./windows');
    createCompactWindow({
      controllerUrl: 'http://192.168.1.1:80',
      settings: makeSettings() as never,
    });

    expect(callLog.setAlwaysOnTopArgs).toHaveLength(0);
    expect(callLog.setVisibleOnAllWorkspacesArgs).toHaveLength(0);

    expect(callLog.ctorOptions).not.toBeNull();
    const icon = callLog.ctorOptions!['icon'];
    expect(typeof icon).toBe('string');
    expect((icon as string).endsWith(`${path.sep}icon.ico`)).toBe(true);
  });
});

describe('createExpandedWindow — `icon` posture', () => {
  let restorePlatform: (() => void) | null = null;

  beforeEach(() => {
    callLog.methodOrder = [];
    callLog.setAlwaysOnTopArgs = [];
    callLog.setVisibleOnAllWorkspacesArgs = [];
    callLog.ctorOptions = null;
    vi.resetModules();
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = null;
  });

  it('omits `icon` on darwin (Requirement 7.8)', async () => {
    restorePlatform = pinPlatform('darwin');

    const { createExpandedWindow } = await import('./windows');
    createExpandedWindow({
      controllerUrl: 'http://192.168.1.1:80',
      settings: makeSettings() as never,
    });

    expect(callLog.ctorOptions).not.toBeNull();
    expect(callLog.ctorOptions).not.toHaveProperty('icon');
  });

  it('sets `icon` to icon.ico on win32 (Requirement 7.7)', async () => {
    restorePlatform = pinPlatform('win32');

    const { createExpandedWindow } = await import('./windows');
    createExpandedWindow({
      controllerUrl: 'http://192.168.1.1:80',
      settings: makeSettings() as never,
    });

    expect(callLog.ctorOptions).not.toBeNull();
    const icon = callLog.ctorOptions!['icon'];
    expect(typeof icon).toBe('string');
    expect((icon as string).endsWith(`${path.sep}icon.ico`)).toBe(true);
  });
});
