// Autostart (login item) management for Windows.
//
// Uses Electron's `app.setLoginItemSettings` which handles the
// Windows registry (HKCU\...\Run) for us. On macOS/Linux it
// delegates to the platform's native mechanism.
//
// References:
//   - PLAN.md §Implementation Phases §打磨和打包
//   - Task 9.8

import { app } from 'electron';

/**
 * Enable or disable launching the application at OS login.
 */
export function setAutostart(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * Query whether the application is currently set to launch at login.
 */
export function getAutostart(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
