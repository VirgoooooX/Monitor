// System tray icon and context menu. Owns the application lifecycle:
// closing the compact window hides it; quitting only via the "退出"
// menu item.
//
// References:
//   - design.md §Architecture (`tray.ts`)
//   - PLAN.md §tray.ts

import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';

import type { Scheduler } from './scheduler';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
   * close) and let-the-cascade-run (tray "退出" → `app.quit()` →
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
 * Returns the `Tray` instance so the caller can hold a reference
 * (preventing GC from destroying the tray on Windows).
 */
export function createTray(deps: CreateTrayDeps): Tray {
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
    return Menu.buildFromTemplate([
      {
        label: '显示/隐藏',
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
        label: '展开',
        click: () => onExpand(),
      },
      {
        label: '设置',
        click: () => onSettings(),
      },
      {
        label: isPaused ? '继续' : '暂停采集',
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
        label: '退出',
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

  return tray;
}
