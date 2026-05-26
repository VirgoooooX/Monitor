// Shared IPC channel-name registry for the typed `DesktopApi` contract.
//
// Both the preload bridge (`src/preload/index.ts`) and the future
// main-side IPC handler registry (task 3.11) import the constants
// declared here so that the channel names have a single source of
// truth. Drift between the two sides would silently break IPC.
//
// Convention (design.md §`ipc.ts`):
//   - Invoke methods use the prefix `desktop:<methodName>`,
//     e.g. `desktop:getDashboard`. The prefix prevents accidental
//     collisions with channels other modules may register.
//   - Push channels keep the bare names declared on `DesktopApi.on`
//     (`dashboard.updated`, `openclash.updated`); these are the same
//     names `webContents.send` uses.
//
// Location choice
// ---------------
// This file lives at `src/main/ipc/channels.ts` rather than
// `src/preload/channels.ts` because the canonical owner of channel
// names is the main-process handler registry — the preload bridge is
// a pure forwarder. Both `src/main/**` and `src/preload/**` are
// compiled by `tsconfig.main.json` (CommonJS emit, rootDir=`src`), so
// the relative import `'../main/ipc/channels'` from preload resolves
// cleanly at runtime against `dist/main/ipc/channels.js`.
//
// Renderer code MUST NOT import this module at runtime; the renderer
// is sandboxed and only sees the typed `DesktopApi` exposed via
// `window.desktop`. See `src/renderer/lib/window.d.ts` for the
// renderer-side type augmentation.

import type { DesktopPushChannel } from '../types';

/**
 * Map from `DesktopApi` invoke method name to its IPC channel name.
 *
 * Marked `as const` so the channel-name string literals are preserved
 * in the inferred type and consumers can index this object with a
 * compile-time-known method name without losing precision.
 */
export const DESKTOP_INVOKE_CHANNELS = {
  getDashboard: 'desktop:getDashboard',
  getOpenClashDetails: 'desktop:getOpenClashDetails',
  switchNode: 'desktop:switchNode',
  refreshNow: 'desktop:refreshNow',
  getUsageSummary: 'desktop:getUsageSummary',
  getQuotaStatus: 'desktop:getQuotaStatus',
  getSettings: 'desktop:getSettings',
  updateSettings: 'desktop:updateSettings',
  updateSecret: 'desktop:updateSecret',
  getDiagnostics: 'desktop:getDiagnostics',
  openExpanded: 'desktop:openExpanded',
  // Network Quick Actions panel (network-quick-actions spec, task 10.1).
  // The handlers, schemas, and `DesktopApi` method signatures are wired
  // up in tasks 10.2..10.5; this entry is the single source of truth
  // for the channel names used by both the preload bridge and the
  // main-process handler registry.
  getNetworkQuickActions: 'desktop:getNetworkQuickActions',
  switchOpenClashConfig: 'desktop:switchOpenClashConfig',
  clearManagementCredentials: 'desktop:clearManagementCredentials',
  // CPA quota import (cpa-quota-import spec, task 10.1).
  // Handlers, schemas, and `DesktopApi` method signatures are wired
  // up in subsequent tasks; this entry is the single source of truth
  // for the channel names used by both the preload bridge and the
  // main-process handler registry.
  listProviderAuths: 'desktop:listProviderAuths',
  importProviderAuthFile: 'desktop:importProviderAuthFile',
  deleteProviderAuth: 'desktop:deleteProviderAuth',
  refreshProviderQuota: 'desktop:refreshProviderQuota',
  validateProviderAuth: 'desktop:validateProviderAuth',
  // AI 账号 unified entry points (planning doc §IPC). New v2 channels;
  // the existing CPA channels stay as the file-import path.
  createProviderAuthApiKey: 'desktop:createProviderAuthApiKey',
  setProviderAuthEnabled: 'desktop:setProviderAuthEnabled',
} as const;

/** Compile-time union of every supported invoke method name. */
export type DesktopInvokeMethod = keyof typeof DESKTOP_INVOKE_CHANNELS;

/** Compile-time union of every concrete invoke channel string. */
export type DesktopInvokeChannel =
  (typeof DESKTOP_INVOKE_CHANNELS)[DesktopInvokeMethod];

/**
 * Static list of every push channel the main process is allowed to
 * dispatch on. Used by preload to whitelist `on(channel, cb)` calls
 * — any other channel name is rejected before `ipcRenderer.on` is
 * even invoked.
 */
export const DESKTOP_PUSH_CHANNELS = [
  'dashboard.updated',
  'openclash.updated',
  'navigate-tab',
  'settings.updated',
] as const satisfies readonly DesktopPushChannel[];

/**
 * Type-narrowing predicate. Treat the input as an unknown blob
 * because preload may be called with arbitrary renderer-supplied
 * values; the cast inside the predicate is intentional.
 */
export function isDesktopPushChannel(
  value: unknown,
): value is DesktopPushChannel {
  if (typeof value !== 'string') {
    return false;
  }
  return (DESKTOP_PUSH_CHANNELS as readonly string[]).includes(value);
}
