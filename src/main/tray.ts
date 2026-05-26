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
  const { compactWindow, scheduler, onExpand, onSettings, getIconPath } = deps;

  // --- Tray icon ---
  const icon = nativeImage.createFromPath(getIconPath());
  const tray = new Tray(icon);
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
  let isQuitting = false;

  app.on('before-quit', () => {
    isQuitting = true;
  });

  compactWindow.on('close', (event) => {
    // Only hide if the app is not quitting. When `app.quit()` is
    // called the `before-quit` event fires first; we use that to
    // distinguish an intentional quit from a user-initiated window
    // close (e.g. Alt+F4).
    if (!isQuitting) {
      event.preventDefault();
      compactWindow.hide();
    }
  });

  return tray;
}
