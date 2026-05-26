// DeepSeek usage collector.
//
// References:
//   - design.md §Property 17
//   - PLAN.md §AI Usage Collectors §DeepSeek
//
// Calls `GET https://api.deepseek.com/user/balance` with Bearer auth
// to retrieve balance/usage info. Throttled to ≤ 1 call per hour.
//
// Privacy:
//   - NEVER stores API keys, prompts, responses, or auth tokens in
//     usage_events.
//   - Only extracts: timestamp, balance info, cost_usd.
//
// Default: disabled in settings.collectors.
// Requires: `deepseek_api_key` in secrets store.

import type { CapabilityResult } from '../../types';
import type { UsageCollector, UsageCollectorContext } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEEPSEEK_COLLECTOR_ID = 'deepseek';
const PROVIDER = 'deepseek';
const SOURCE = 'deepseek.api';
const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** Minimum interval between API calls: 1 hour in milliseconds. */
const THROTTLE_MS = 60 * 60 * 1000;

/** Settings key for persisted last call timestamp. */
const LAST_CALL_TS_KEY = 'deepseek.lastCallTs';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * Function to retrieve the DeepSeek API key from secrets.
 * Returns `null` if no key is configured.
 */
export type GetSecretFn = (key: string) => string | null;

/**
 * HTTP fetch function for testability. Matches the global `fetch` signature
 * subset we need.
 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Simple key-value store for persisting collector state (e.g. lastCallTs).
 * Maps to the settings repository in production.
 */
export interface DeepSeekStateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface DeepSeekCollectorDeps {
  /** Retrieve API key from secrets. */
  getSecret: GetSecretFn;
  /** HTTP fetch implementation. Defaults to global `fetch`. */
  fetch?: FetchFn;
  /** State store for persisting lastCallTs. */
  stateStore?: DeepSeekStateStore;
}

// ---------------------------------------------------------------------------
// Response types (from DeepSeek API)
// ---------------------------------------------------------------------------

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

// ---------------------------------------------------------------------------
// Collector implementation
// ---------------------------------------------------------------------------

/**
 * Create the DeepSeek usage collector.
 *
 * Capability check:
 *   - Check if API key exists in secrets via `getSecret('deepseek_api_key')`
 *   - If no key → `unavailable + "需要配置 DeepSeek API Key"`
 *
 * Tick:
 *   - Throttle: maintain `lastCallTs`, skip if within 1 hour
 *   - On first enable (no lastCallTs), call immediately
 *   - Call GET `https://api.deepseek.com/user/balance` with Bearer auth
 *   - Parse response for balance/usage info
 *   - Store `costUsd` if available from balance response
 */
export function createDeepSeekCollector(deps: DeepSeekCollectorDeps): UsageCollector {
  const { getSecret } = deps;
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchFn);

  // In-memory fallback for lastCallTs when no stateStore is provided
  let inMemoryLastCallTs: number | null = null;

  function getLastCallTs(stateStore?: DeepSeekStateStore): number | null {
    if (stateStore) {
      return stateStore.get<number>(LAST_CALL_TS_KEY) ?? null;
    }
    return inMemoryLastCallTs;
  }

  function setLastCallTs(ts: number, stateStore?: DeepSeekStateStore): void {
    if (stateStore) {
      stateStore.set<number>(LAST_CALL_TS_KEY, ts);
    }
    inMemoryLastCallTs = ts;
  }

  return {
    id: DEEPSEEK_COLLECTOR_ID,

    async capabilityCheck(): Promise<CapabilityResult> {
      const apiKey = getSecret('deepseek_api_key');
      if (!apiKey) {
        return {
          status: 'unavailable',
          reason: '需要配置 DeepSeek API Key',
        };
      }
      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      const apiKey = getSecret('deepseek_api_key');
      if (!apiKey) return;

      const now = ctx.now();
      const lastCallTs = getLastCallTs(deps.stateStore);

      // Throttle: skip if last call was within 1 hour (unless first call)
      if (lastCallTs !== null && (now - lastCallTs) < THROTTLE_MS) {
        return;
      }

      // Call the balance API
      let response: Awaited<ReturnType<FetchFn>>;
      try {
        response = await fetchImpl(BALANCE_URL, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
          },
        });
      } catch {
        // Network error — skip silently, will retry next tick
        return;
      }

      // Record the call timestamp regardless of response status
      setLastCallTs(now, deps.stateStore);

      if (!response.ok) {
        // Non-2xx — skip silently
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return;
      }

      // Parse balance response
      const balanceResponse = body as Partial<BalanceResponse>;
      if (!balanceResponse.balance_infos || !Array.isArray(balanceResponse.balance_infos)) {
        return;
      }

      // Extract cost info from balance_infos
      // The total_balance represents remaining credit; we track it as a usage event
      for (const info of balanceResponse.balance_infos) {
        if (!info || typeof info.total_balance !== 'string') continue;

        const totalBalance = parseFloat(info.total_balance);
        if (!Number.isFinite(totalBalance)) continue;

        // Use a deterministic source_offset based on the timestamp to enable dedup
        // For API-based collectors, we use the call timestamp as the offset
        const sourceOffset = now;

        ctx.usageEvents.insertIgnore({
          timestamp: now,
          provider: PROVIDER,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          costUsd: totalBalance >= 0 ? totalBalance : null,
          source: SOURCE,
          sourcePath: BALANCE_URL,
          sourceOffset,
          eventId: `balance-${now}-${info.currency ?? 'unknown'}`,
        });
      }
    },
  };
}
