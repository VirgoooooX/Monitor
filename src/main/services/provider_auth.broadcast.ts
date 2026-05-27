// Provider_Auth push broadcaster.
//
// Wraps `BrowserWindow.webContents.send('provider-auth.updated', …)`
// fan-out so every IPC handler that mutates the `provider_auth` table
// (create / delete / import / setEnabled / refresh) can notify all
// open renderers in one line. The renderers are the floating
// (compact) window and the optional expanded settings/dashboard
// window — both render their own slice of the same dataset, and we
// want them to react the same way they react to `dashboard.updated`.
//
// Why not push from the SQLite repository?
//   The push must carry a *fresh* `QuotaStatus` so the QuotaStrip and
//   CompactMiniRail can re-render without an extra round-trip. The
//   QuotaService is the only source of that envelope, so the
//   broadcast is best driven from the IPC layer that already owns
//   both the providerAuthService row writes and the quotaService
//   cache reads.
//
// The wire format is `ProviderAuthUpdatedPayload` declared in
// `src/main/types.ts`. `reason` is a closed enum so renderers can
// switch on it (e.g. an "imported" reason can trigger a one-shot
// background quota refresh on top of the cache hit).

import type { BrowserWindow } from 'electron';

import type {
  ProviderAuthMetadata,
  ProviderAuthUpdatedPayload,
  QuotaStatus,
} from '../types';

const CHANNEL = 'provider-auth.updated';

export interface ProviderAuthBroadcaster {
  /**
   * Push a `provider-auth.updated` event to every live BrowserWindow.
   * Snapshot read of the windows list so a window destroyed mid-loop
   * is skipped instead of throwing. `try/catch` per send so a single
   * dead webContents cannot abort the rest of the fan-out.
   */
  broadcast(payload: ProviderAuthUpdatedPayload): void;
}

export interface ProviderAuthBroadcasterDeps {
  /**
   * Resolve the live windows we should notify. Lazy on every call
   * (rather than capturing a snapshot at construction time) because
   * `_expandedWindow` opens / closes throughout the app lifetime.
   */
  getWindows: () => readonly BrowserWindow[];
}

export function createProviderAuthBroadcaster(
  deps: ProviderAuthBroadcasterDeps,
): ProviderAuthBroadcaster {
  return {
    broadcast(payload: ProviderAuthUpdatedPayload): void {
      const windows = deps.getWindows();
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(CHANNEL, payload);
        } catch {
          // A dead webContents between `isDestroyed` and `send` is
          // not fatal — the next refresh / next mutation will retry.
        }
      }
    },
  };
}

/**
 * Build the wire payload from a list of redacted `ProviderAuthMetadata`
 * rows and the current `QuotaStatus`. Centralised so handlers do not
 * accidentally drop the `reason` discriminator. The function is pure
 * — taking `rows` / `quotaStatus` as inputs keeps the broadcaster
 * itself free of any service couplings.
 */
export function buildProviderAuthUpdatedPayload(
  reason: ProviderAuthUpdatedPayload['reason'],
  rows: readonly ProviderAuthMetadata[],
  quotaStatus: QuotaStatus,
): ProviderAuthUpdatedPayload {
  return { reason, rows, quotaStatus };
}
