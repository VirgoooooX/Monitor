// Quota service — aggregates quota/rate-limit data from all providers.
//
// Throttles remote API calls to avoid hitting rate limits:
//   - Codex remote: max once per 5 minutes
//   - Falls back to local log parsing between remote refreshes
//
// The service caches the latest snapshot in memory and persists it to
// the settings store so the renderer can display stale-but-useful data
// immediately on boot.

import type { QuotaSnapshot, QuotaStatus } from '../types';
import type { SettingsRepository } from '../store/repositories';
import { getCodexQuotaSnapshot } from '../collectors/usage/codex-quota.collector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'quota.snapshots';

/** Minimum interval between remote API calls (ms). */
const REMOTE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface QuotaService {
  /** Get the current quota status (may return cached data). */
  getQuotaStatus(): Promise<QuotaStatus>;
  /** Force a refresh (respects throttling for remote calls). */
  refresh(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface QuotaServiceDeps {
  settings: SettingsRepository;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const getClock = deps.now ?? Date.now;

  // In-memory cache
  let cachedSnapshots: QuotaSnapshot[] = loadPersistedSnapshots(deps.settings);
  let lastRemoteFetchAt = 0;

  return {
    async getQuotaStatus(): Promise<QuotaStatus> {
      // If cache is stale (> throttle interval), try a background refresh
      const now = getClock();
      if (now - lastRemoteFetchAt > REMOTE_THROTTLE_MS) {
        // Don't await — return cached immediately, refresh in background
        void refreshInternal(now);
      }

      return { snapshots: cachedSnapshots };
    },

    async refresh(): Promise<void> {
      await refreshInternal(getClock());
    },
  };

  async function refreshInternal(now: number): Promise<void> {
    const newSnapshots: QuotaSnapshot[] = [];

    // Codex quota
    try {
      const useRemote = now - lastRemoteFetchAt > REMOTE_THROTTLE_MS;
      let codexSnapshot: QuotaSnapshot | null = null;

      if (useRemote) {
        // Try remote first, then fall back to local
        const { fetchRemoteQuota, parseLocalRateLimits } = await import(
          '../collectors/usage/codex-quota.collector'
        );
        codexSnapshot = await fetchRemoteQuota();
        if (codexSnapshot) {
          lastRemoteFetchAt = now;
        } else {
          codexSnapshot = await parseLocalRateLimits();
        }
      } else {
        // Between remote intervals, only do local parsing
        const { parseLocalRateLimits } = await import(
          '../collectors/usage/codex-quota.collector'
        );
        codexSnapshot = await parseLocalRateLimits();
      }

      if (codexSnapshot) {
        newSnapshots.push(codexSnapshot);
      }
    } catch {
      // Non-fatal — keep existing cache
    }

    // TODO: Add Gemini, Claude, DeepSeek quota fetchers here

    // Merge: keep existing snapshots for providers not refreshed
    const refreshedProviders = new Set(newSnapshots.map((s) => s.provider));
    const merged = [
      ...newSnapshots,
      ...cachedSnapshots.filter((s) => !refreshedProviders.has(s.provider)),
    ];

    cachedSnapshots = merged;

    // Persist to settings for next boot
    deps.settings.set(SETTINGS_KEY, merged);
  }
}

function loadPersistedSnapshots(settings: SettingsRepository): QuotaSnapshot[] {
  try {
    const stored = settings.get<QuotaSnapshot[]>(SETTINGS_KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}
