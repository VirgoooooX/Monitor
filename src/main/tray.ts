// System tray icon and context menu. Owns the application lifecycle:
// closing the compact window hides it; quitting only via the tray
// `tray.menu.quit` item.
//
// Every visible Tray_Menu_Items label is sourced from
// `t('tray.menu.*')` against the i18n public façade (Requirements 5.1,
// 5.7). The tray tooltip stays the locale-neutral brand string
// `"Monitor"` (Requirement 5.7). The pause / resume label switches
// based on the local `isPaused` flag and is rebuilt via
// `Menu.buildFromTemplate` + `tray.setContextMenu(...)` so the entire
// menu is re-resolved against the live Active_Locale on every tick
// (Requirement 5.2 / 5.3).
//
// References:
//   - design.md §Architecture (`tray.ts`), §Tray menu rebuild
//   - PLAN.md §tray.ts
//   - .kiro/specs/i18n-multilingual-support/requirements.md §5

import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';

import { t } from '../i18n';

import type { Scheduler } from './scheduler';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Return value of {@link createTray}. The handle bundles the live
 * `Tray` instance (so the caller can keep a reference and prevent GC
 * from destroying the tray on Windows — Electron's documented
 * requirement) with a `rebuild()` method that re-resolves every
 * Tray_Menu_Items label against the current Active_Locale and
 * re-attaches the menu via `tray.setContextMenu(...)`
 * (Requirement 5.3, design.md §Tray menu rebuild).
 *
 * Why a small handle object instead of returning the `Tray` directly:
 *
 *   - The locale-change side effect in `applyAppSettingsPatch`
 *     (i18n-multilingual-support task 7.3) needs to ask the tray to
 *     rebuild without reaching into the tray module's local
 *     `buildContextMenu` closure. Exposing `rebuild()` keeps that
 *     closure encapsulated here.
 *   - The `tray` field stays public because some call sites (and the
 *     existing GC-safety hold-the-reference invariant) still need to
 *     observe the underlying `Tray` instance — e.g. for teardown or
 *     destroyed-state checks.
 */
export interface TrayHandle {
  /**
   * The underlying Electron `Tray`. The caller MUST hold this
   * reference for the lifetime of the application; on Windows the
   * tray icon is collected and removed from the notification area
   * if the JS handle is GC'd. Production code keeps the parent
   * `TrayHandle` (which transitively pins this field) on a
   * module-level `let` in `app.ts`.
   */
  readonly tray: Tray;

  /**
   * Re-resolve every Tray_Menu_Items label against the live
   * Active_Locale (via `t('tray.menu.*')`) and re-attach the menu
   * via `tray.setContextMenu(...)`. Idempotent: safe to call when
   * the menu is already in the desired state — at worst it builds
   * one redundant `Menu` instance.
   *
   * Invoked from `applyAppSettingsPatch` whenever
   * `prev.locale !== next.locale`, after `setActiveLocale(...)` has
   * already pointed the i18n singleton at the new catalog
   * (i18n-multilingual-support Requirement 5.3 — rebuild within
   * 500 ms of `settings.updated`).
   */
  rebuild(): void;
}

/**
 * Dependencies injected into the tray factory. Keeps the module
 * decoupled from global singletons so it remains testable.
 */
export interface CreateTrayDeps {
  /** The always-on-top compact widget window. */
  compactWindow: BrowserWindow;
  /** The process-wide scheduler instance. */
  scheduler: Scheduler;
  /** Callback to open (or focus) the expanded window. */
  onExpand: () => void;
  /** Callback to open (or focus) the settings view. */
  onSettings: () => void;
  /** Returns the absolute path to the tray icon asset. */
  getIconPath: () => string;
  /**
   * Returns whether the application is in the middle of quitting
   * (Requirement 8.5). The compact window's `close` event handler
   * uses this to decide between hide-instead-of-quit (normal user
   * close) and let-the-cascade-run (tray quit item → `app.quit()` →
   * `before-quit` → flag flip).
   *
   * Hoisted out of the previous tray-local closure to module scope
   * in {@link app.ts} so any second `before-quit` listener
   * registered after the application's can also observe the flag
   * synchronously. The deps callback reads the live value through
   * {@link app.ts#isAppQuitting} on every close-event tick.
   */
  isAppQuitting: () => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the system tray icon with its context menu and wire the
 * compact-window close event to hide-instead-of-quit behaviour.
 *
 * Returns a {@link TrayHandle} bundling the underlying `Tray` (so
 * the caller can hold the reference Electron requires for GC
 * safety on Windows) with a `rebuild()` method the caller invokes
 * whenever the Active_Locale changes (i18n-multilingual-support
 * Requirements 5.3 / 7.5).
 */
export function createTray(deps: CreateTrayDeps): TrayHandle {
  const { compactWindow, scheduler, onExpand, onSettings, getIconPath, isAppQuitting } = deps;

  // --- Tray icon ---
  //
  // The per-platform asset selection lives in the injected
  // `getIconPath` closure (Requirement 5.6); this body must contain
  // no `process.platform` branching for icon selection.
  //
  // The single `process.platform` reference below is **not** an icon
  // selection — it flips the AppKit template-image flag on the
  // already-loaded `nativeImage`. The flag has no equivalent on
  // win32 / linux; calling `setTemplateImage(true)` on the macOS
  // path is idempotent, and on win32 / linux the call site is
  // guarded so the flag is never set there. AppKit also auto-
  // detects template images by the `Template` filename suffix, so
  // this explicit call is belt-and-suspenders defence in case a
  // future asset rename loses the suffix — Requirement 5.4 /
  // 5.5 / 13.4 and design.md §`src/main/tray.ts`.
  const image = nativeImage.createFromPath(getIconPath());
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  const tray = new Tray(image);
  tray.setToolTip('Monitor');

  // --- Pause/resume state ---
  let isPaused = false;

  function buildContextMenu(): Menu {
    // Every label is resolved against the live Active_Locale on each
    // call. Because `t(...)` reads `getActiveLocale()` per-call (see
    // `src/i18n/index.ts`), a `setActiveLocale(...)` write followed
    // by `tray.setContextMenu(buildContextMenu())` is sufficient to
    // surface the new locale's labels — no per-item closure rebind
    // required (Requirements 5.1, 5.3).
    return Menu.buildFromTemplate([
      {
        label: t('tray.menu.toggle'),
        click: () => {
          if (compactWindow.isDestroyed()) return;
          if (compactWindow.isVisible()) {
            compactWindow.hide();
          } else {
            compactWindow.show();
          }
        },
      },
      {
        label: t('tray.menu.expand'),
        click: () => onExpand(),
      },
      {
        label: t('tray.menu.settings'),
        click: () => onSettings(),
      },
      {
        label: isPaused ? t('tray.menu.resume') : t('tray.menu.pause'),
        click: () => {
          if (isPaused) {
            scheduler.resume();
            isPaused = false;
          } else {
            scheduler.pause();
            isPaused = true;
          }
          // Rebuild the menu so the label reflects the new state.
          tray.setContextMenu(buildContextMenu());
        },
      },
      { type: 'separator' },
      {
        label: t('tray.menu.quit'),
        click: () => {
          app.quit();
        },
      },
    ]);
  }

  tray.setContextMenu(buildContextMenu());

  // --- Compact-window close → hide (don't quit) ---
  //
  // The `before-quit` flag is owned by `app.ts` (Requirement 8.5)
  // and read here through the injected `isAppQuitting` closure so
  // the tray module no longer registers its own `before-quit`
  // listener. This makes the ordering observable from a unit test
  // that subscribes a second `before-quit` listener after the
  // application's: by the time the second listener runs, the
  // module-level flag is already `true`.

  compactWindow.on('close', (event) => {
    // Only hide if the app is not quitting. When `app.quit()` is
    // called the `before-quit` event fires first; we use that to
    // distinguish an intentional quit from a user-initiated window
    // close (e.g. Alt+F4).
    if (!isAppQuitting()) {
      event.preventDefault();
      compactWindow.hide();
    }
  });

  return {
    tray,
    rebuild() {
      // Rebuild the entire context menu via `Menu.buildFromTemplate`
      // and re-attach via `tray.setContextMenu(...)` so every
      // Tray_Menu_Items label is re-resolved against the live
      // Active_Locale (Requirements 5.1, 5.2, 5.3). Defensive guard
      // against post-destroy invocation: Electron throws if methods
      // are called on a destroyed `Tray`, so we early-return when
      // the underlying handle has already been torn down.
      if (tray.isDestroyed()) return;
      tray.setContextMenu(buildContextMenu());
    },
  };
}
