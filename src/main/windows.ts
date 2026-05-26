// Window factory and process-level security wiring.
//
// This module is the single source of truth for `BrowserWindow`
// creation. Centralising the work here ensures that every window the
// app ever opens shares the same hardened `webPreferences`, the same
// CSP, and the same navigation allowlist.
//
// References:
//   - design.md §Security Boundaries
//   - design.md §Window Strategy
//   - design.md §`windows.ts` (interface contract)
//   - design.md §Property 19 (CSP connect-src matches controllerUrl)
//   - PLAN.md §windows.ts
//
// Design notes:
//   - `SECURE_WEB_PREFERENCES` is exported so unit/audit tests can
//     diff it against `BrowserWindow#webPreferences` and assert the
//     production preference set has not silently regressed.
//   - `applyCspHeaders` is idempotent: it always tears down the prior
//     `onHeadersReceived` listener before installing the new one. This
//     is the path used both at boot and whenever the user edits
//     `controllerUrl` in Settings (task 9.1).
//   - Bound persistence goes through the `SettingsRepository`
//     contract instead of writing to SQLite directly, keeping all DB
//     access funnelled through one repository surface.
//   - Off-screen bounds (saved on a monitor that has since been
//     unplugged) are silently discarded so the window cannot end up
//     painted into a coordinate space the user cannot reach.

import path from 'node:path';

import { app, BrowserWindow, screen, session } from 'electron';

import type { SettingsRepository } from './store/repositories';

// ---------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------

/** Discriminator for the two window kinds we persist. */
export type WindowKind = 'compact' | 'expanded';

/**
 * Hardened `webPreferences` applied to every `BrowserWindow` the app
 * ever opens (design.md §Security Boundaries).
 *
 * Every flag is set explicitly, even where the Electron default
 * already matches, so that a future Electron upgrade flipping a
 * default cannot quietly relax our posture.
 */
export const SECURE_WEB_PREFERENCES: Electron.WebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  preload: path.join(__dirname, '..', 'preload', 'index.js'),
};

/**
 * Settings keys for persisted window bounds. Exported so tests and
 * the diagnostics export can reason about them by name.
 */
export const COMPACT_BOUNDS_KEY = 'window.compact.bounds';
export const EXPANDED_BOUNDS_KEY = 'window.expanded.bounds';

/** Minimum on-screen overlap (in DIPs²) for saved bounds to be considered usable. */
const MIN_ONSCREEN_OVERLAP = 100 * 100;

/** Auto-save debounce for `move` / `resize` events. */
const BOUNDS_SAVE_DEBOUNCE_MS = 250;

/** Compact-window default size (design.md §Window Strategy). */
export const COMPACT_DEFAULT_SIZE = { width: 360, height: 240 } as const;

/** Expanded-window default size (design.md §Window Strategy). */
export const EXPANDED_DEFAULT_SIZE = { width: 760, height: 560 } as const;

/** Sentinel origin used to represent the renderer's own `file://` URL in production. */
export const FILE_SELF_ORIGIN = 'file://';

/**
 * Dependencies threaded into the window factories. The `session`
 * override is intended for tests that want to assert against a custom
 * `Electron.Session` instance; production callers omit it and the
 * factory falls back to `session.defaultSession`.
 */
export interface CreateWindowDeps {
  controllerUrl: string;
  settings: SettingsRepository;
  session?: Electron.Session;
}

// ---------------------------------------------------------------------------
// CSP and navigation guards
// ---------------------------------------------------------------------------

/**
 * Build the canonical CSP string emitted by the main-process header
 * injector and mirrored by the `<meta http-equiv>` in `index.html`.
 *
 * `allowedConnect` is the list of additional origins the renderer is
 * permitted to fetch from beyond `'self'` — typically the OpenClash
 * controller origin.
 */
export function buildCspHeaderValue(allowedConnect: readonly string[]): string {
  const connectSources = ["'self'", ...allowedConnect].join(' ');
  const isDev = !app.isPackaged;
  // In dev mode, Vite injects inline scripts and uses eval for HMR.
  const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  const styleSrc = "'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data:",
    `connect-src ${connectSources}`,
  ].join('; ');
}

/**
 * Install (or replace) the `onHeadersReceived` listener that injects
 * the application's CSP header into every response served on the
 * given session.
 *
 * Idempotent: the prior listener is torn down via
 * `onHeadersReceived(null)` before the new one is attached, so this
 * function is safe to call repeatedly (e.g. when the user changes
 * `controllerUrl` in Settings — task 9.1).
 */
export function applyCspHeaders(
  targetSession: Electron.Session,
  allowedConnect: readonly string[],
): void {
  // Clear any previously-installed listener so this function can be
  // re-invoked freely. Electron's webRequest API allows exactly one
  // handler per event, so we must remove before re-adding.
  targetSession.webRequest.onHeadersReceived(null);

  const cspValue = buildCspHeaderValue(allowedConnect);

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    // Copy existing headers so we do not mutate Electron-owned state.
    const headers: Record<string, string | string[]> = {};
    const existing = details.responseHeaders;
    if (existing) {
      for (const [key, value] of Object.entries(existing)) {
        // Strip any pre-existing CSP variants (e.g. emitted by the dev
        // server or the html shell's <meta>) so our value is the only
        // one the renderer ever sees.
        if (key.toLowerCase() === 'content-security-policy') {
          continue;
        }
        if (Array.isArray(value)) {
          headers[key] = value;
        } else if (value !== undefined) {
          headers[key] = value;
        }
      }
    }
    headers['Content-Security-Policy'] = [cspValue];

    callback({ responseHeaders: headers });
  });
}

/**
 * Decide whether a navigation target is allowed.
 *
 * Comparison is by URL `origin` for http(s):// targets. `file://`
 * targets (used by production where the renderer is loaded via
 * `loadFile`) are matched against the {@link FILE_SELF_ORIGIN}
 * sentinel because `new URL('file://...').origin` returns `'null'`,
 * making string-equality unreliable.
 */
export function isOriginAllowed(
  targetUrl: string,
  allowedOrigins: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') {
    return allowedOrigins.includes(FILE_SELF_ORIGIN);
  }
  return allowedOrigins.includes(parsed.origin);
}

/**
 * Install `will-navigate` and `setWindowOpenHandler` denials on a
 * window's `webContents`. Any URL whose origin is not in
 * `allowedOrigins` is rejected (design.md §Security Boundaries).
 *
 * Callers must include the renderer's own origin (the dev URL in dev
 * mode, or {@link FILE_SELF_ORIGIN} in production) in the allowlist
 * so that the initial page load and intra-app navigation are not
 * blocked.
 */
export function applyNavigationGuards(
  window: BrowserWindow,
  allowedOrigins: readonly string[],
): void {
  // Snapshot once so subsequent in-place mutation of the array a
  // caller passed does not leak through.
  const allowlist = [...allowedOrigins];

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isOriginAllowed(navigationUrl, allowlist)) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isOriginAllowed(url, allowlist)) {
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Bounds persistence
// ---------------------------------------------------------------------------

function boundsKey(kind: WindowKind): string {
  return kind === 'compact' ? COMPACT_BOUNDS_KEY : EXPANDED_BOUNDS_KEY;
}

function isValidRectangle(value: unknown): value is Electron.Rectangle {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return false;
    }
  }
  // Width/height must be positive — a zero-area rectangle would
  // never overlap any display.
  return (obj['width'] as number) > 0 && (obj['height'] as number) > 0;
}

/**
 * Returns `true` when {@link bounds} overlaps at least
 * {@link MIN_ONSCREEN_OVERLAP} square DIPs of any currently-attached
 * display's `workArea`. This is what we use to detect "the user
 * unplugged the monitor that this window used to live on".
 */
function isBoundsOnAnyScreen(bounds: Electron.Rectangle): boolean {
  // `screen.getAllDisplays` is only safe to call after `app.whenReady`
  // has resolved. The factories below are themselves only invoked
  // post-`whenReady`, so this is fine.
  let displays: Electron.Display[];
  try {
    displays = screen.getAllDisplays();
  } catch {
    // If `screen` is unavailable (e.g. unit-test harness without a
    // running Electron app) we conservatively reject saved bounds —
    // callers fall back to defaults, which is always safe.
    return false;
  }
  for (const display of displays) {
    const area = display.workArea;
    const overlapW = Math.max(
      0,
      Math.min(bounds.x + bounds.width, area.x + area.width) -
        Math.max(bounds.x, area.x),
    );
    const overlapH = Math.max(
      0,
      Math.min(bounds.y + bounds.height, area.y + area.height) -
        Math.max(bounds.y, area.y),
    );
    if (overlapW * overlapH >= MIN_ONSCREEN_OVERLAP) {
      return true;
    }
  }
  return false;
}

/**
 * Persist a window's current bounds under the kind-specific settings
 * key. No-ops if {@link bounds} is malformed (defensive: we never
 * want a corrupt save to brick the next launch).
 */
export function saveBounds(
  settings: SettingsRepository,
  kind: WindowKind,
  bounds: Electron.Rectangle,
): void {
  if (!isValidRectangle(bounds)) {
    return;
  }
  // Normalise to plain integers — Electron occasionally yields
  // sub-pixel values on fractional-DPI displays which we do not need
  // to preserve.
  const normalised: Electron.Rectangle = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  settings.set<Electron.Rectangle>(boundsKey(kind), normalised);
}

/**
 * Read previously-persisted bounds for {@link kind}. Returns `null`
 * (and clears the corrupt/off-screen entry) when:
 *
 *   - no value has ever been saved,
 *   - the stored value is not a valid `Rectangle`,
 *   - the rectangle does not overlap any currently-attached display.
 *
 * Callers are expected to fall back to the kind's default bounds when
 * `null` is returned.
 */
export function restoreBounds(
  settings: SettingsRepository,
  kind: WindowKind,
): Electron.Rectangle | null {
  const key = boundsKey(kind);
  const saved = settings.get<unknown>(key);
  if (saved === undefined) {
    return null;
  }
  if (!isValidRectangle(saved)) {
    settings.remove(key);
    return null;
  }
  if (!isBoundsOnAnyScreen(saved)) {
    settings.remove(key);
    return null;
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Window factories
// ---------------------------------------------------------------------------

/**
 * Resolve the renderer entry. In dev mode we load from the Vite dev
 * server (exposed by `scripts/dev.mjs` via `VITE_DEV_SERVER_URL`); in
 * production we load `dist/renderer/index.html` from disk.
 *
 * `app.isPackaged` is honoured as a tiebreaker: a packaged build
 * never trusts a stray `VITE_DEV_SERVER_URL` env var.
 */
function resolveRendererTarget(): {
  kind: 'devServer'; url: string; selfOrigin: string;
} | {
  kind: 'file'; filePath: string; selfOrigin: string;
} {
  const devUrl = process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devUrl !== undefined && devUrl.length > 0) {
    let origin: string;
    try {
      origin = new URL(devUrl).origin;
    } catch {
      origin = devUrl;
    }
    return { kind: 'devServer', url: devUrl, selfOrigin: origin };
  }
  return {
    kind: 'file',
    filePath: path.join(__dirname, '..', 'renderer', 'index.html'),
    selfOrigin: FILE_SELF_ORIGIN,
  };
}

/** Compute the controller origin used for both CSP and nav allowlist. */
function controllerOrigin(controllerUrl: string): string {
  try {
    return new URL(controllerUrl).origin;
  } catch {
    // The settings layer (schemas.ts) already validated this; if it
    // somehow slips through we fall back to the raw string so CSP
    // does not silently widen.
    return controllerUrl;
  }
}

/**
 * Wire up debounced bounds persistence on `move` and `resize`.
 *
 * The compact window is `resizable: false`, so its `resize` event
 * never fires in practice, but `move` still does — which is the only
 * thing we need for the compact case.
 */
function attachBoundsAutoSave(
  window: BrowserWindow,
  settings: SettingsRepository,
  kind: WindowKind,
): void {
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    timer = null;
    if (window.isDestroyed()) {
      return;
    }
    saveBounds(settings, kind, window.getBounds());
  };

  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, BOUNDS_SAVE_DEBOUNCE_MS);
  };

  window.on('move', schedule);
  window.on('resize', schedule);
  window.on('closed', () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

/** Load whatever entry `resolveRendererTarget` chose. */
function loadRenderer(window: BrowserWindow, mode?: 'compact' | 'expanded'): void {
  const target = resolveRendererTarget();
  const hash = mode ? `#${mode}` : '';
  if (target.kind === 'devServer') {
    void window.loadURL(target.url + hash);
  } else {
    void window.loadFile(target.filePath, { hash });
  }
}

/**
 * Create the always-on-top compact widget window
 * (design.md §Window Strategy):
 *
 *   - 360 × 240
 *   - `transparent: true`, `frame: false`
 *   - `alwaysOnTop: true`
 *   - `resizable: false`
 */
export function createCompactWindow(deps: CreateWindowDeps): BrowserWindow {
  const targetSession = deps.session ?? session.defaultSession;
  const target = resolveRendererTarget();
  const ctlOrigin = controllerOrigin(deps.controllerUrl);

  // In dev mode, Vite's HMR websocket needs connect-src access.
  const allowedConnect = target.kind === 'devServer'
    ? [ctlOrigin, target.selfOrigin, `ws://localhost:*`]
    : [ctlOrigin];
  applyCspHeaders(targetSession, allowedConnect);

  const savedBounds = restoreBounds(deps.settings, 'compact');

  const options: Electron.BrowserWindowConstructorOptions = {
    width: COMPACT_DEFAULT_SIZE.width,
    height: COMPACT_DEFAULT_SIZE.height,
    minWidth: COMPACT_DEFAULT_SIZE.width,
    minHeight: COMPACT_DEFAULT_SIZE.height,
    maxWidth: COMPACT_DEFAULT_SIZE.width,
    maxHeight: COMPACT_DEFAULT_SIZE.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: { ...SECURE_WEB_PREFERENCES, session: targetSession },
  };

  if (savedBounds) {
    // For compact, only x/y are restored; size is fixed.
    options.x = savedBounds.x;
    options.y = savedBounds.y;
  }

  const window = new BrowserWindow(options);

  applyNavigationGuards(window, [target.selfOrigin, ctlOrigin]);
  attachBoundsAutoSave(window, deps.settings, 'compact');
  loadRenderer(window, 'compact');

  // Defer first paint until the renderer is ready; avoids the black
  // flash that Windows shows when a transparent + frameless window
  // becomes visible before the first frame is composited.
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });

  return window;
}

/**
 * Create the framed expanded window (design.md §Window Strategy):
 *
 *   - 760 × 560
 *   - `transparent: false`, `frame: true`
 *   - `resizable: true`
 */
export function createExpandedWindow(deps: CreateWindowDeps): BrowserWindow {
  const targetSession = deps.session ?? session.defaultSession;
  const target = resolveRendererTarget();
  const ctlOrigin = controllerOrigin(deps.controllerUrl);

  const allowedConnect = target.kind === 'devServer'
    ? [ctlOrigin, target.selfOrigin, `ws://localhost:*`]
    : [ctlOrigin];
  applyCspHeaders(targetSession, allowedConnect);

  const savedBounds = restoreBounds(deps.settings, 'expanded');

  const options: Electron.BrowserWindowConstructorOptions = {
    width: savedBounds?.width ?? EXPANDED_DEFAULT_SIZE.width,
    height: savedBounds?.height ?? EXPANDED_DEFAULT_SIZE.height,
    minWidth: 480,
    minHeight: 360,
    transparent: false,
    frame: true,
    resizable: true,
    show: false,
    webPreferences: { ...SECURE_WEB_PREFERENCES, session: targetSession },
  };

  if (savedBounds) {
    options.x = savedBounds.x;
    options.y = savedBounds.y;
  }

  const window = new BrowserWindow(options);

  applyNavigationGuards(window, [target.selfOrigin, ctlOrigin]);
  attachBoundsAutoSave(window, deps.settings, 'expanded');
  loadRenderer(window, 'expanded');

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });

  return window;
}
