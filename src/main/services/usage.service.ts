// Usage aggregation service.
//
// References:
//   - design.md §Data Models §UsageSummary, §Performance Considerations
//   - cpa-quota-import/design.md §Dynamic KNOWN_PROVIDERS
//   - cpa-quota-import/requirements.md Requirement 14.1, 14.2, 14.4
//   - PLAN.md §SQLite Schema §聚合结果
//
// Computes today/week/month aggregates at query time over `usage_events`
// (no materialization in v1). Returns per-provider rows with `status`,
// totals, `eventCount`, and `reason` when status is not `ok`.
//
// `KNOWN_PROVIDERS` is no longer hardcoded — it is derived at query time
// from three sources (in priority order):
//
//   1. The `BASELINE_PROVIDERS` baseline (the providers shipped with v1).
//   2. The set of enabled keys in `app.settings.collectors` — this lets a
//      user-configured provider (qwen, kimi, …) appear in the UI even
//      before the first usage event lands.
//   3. The `provider` column of every row in the `provider_auth` table —
//      so an imported CPA auth file surfaces a row in the usage list
//      regardless of whether the collector has produced an event yet.
//
// `provider_auth` is optional: when no `ProviderAuthRepository` is
// supplied (e.g. in unit tests written before the CPA import feature
// landed) the derivation falls back to baseline + collectors only.

import type {
  CapabilityResult,
  CollectorStatus,
  UsageProviderSummary,
  UsageRange,
  UsageSummary,
  UsageSummaryInput,
} from '../types';
import type {
  ProviderAuthRepository,
  SettingsRepository,
  UsageEventsRepository,
} from '../store/repositories';
import { aggregateToProviderSummary, readAppSettings } from '../store/repositories';
import { readCapabilityResults } from '../collectors/usage/Collector';

// ---------------------------------------------------------------------------
// Known providers
// ---------------------------------------------------------------------------

/**
 * Baseline providers always present in the summary, even when no
 * collector is enabled and no `provider_auth` row exists. These are the
 * providers the desktop widget has shipped with from day one; removing
 * one would silently disappear historical aggregates from the UI.
 */
const BASELINE_PROVIDERS = ['codex', 'gemini', 'antigravity', 'opencode', 'deepseek'] as const;

/**
 * Derive the set of providers to surface in the usage summary at query
 * time. The result is sorted alphabetically and deduplicated.
 *
 * @param collectors    Map of collector keys to enabled-flags from `app.settings`.
 * @param providerAuthRows Optional list of `provider_auth` rows; defaults to empty.
 * @returns Sorted, deduplicated list of provider keys to include in the summary.
 *
 * References:
 *   - cpa-quota-import/design.md §Dynamic KNOWN_PROVIDERS
 *   - cpa-quota-import/requirements.md Requirement 14.1, 14.2, 14.4
 */
export function deriveKnownProviders(
  collectors: Record<string, { enabled: boolean }>,
  providerAuthRows: ReadonlyArray<{ provider: string }> = [],
): string[] {
  const set = new Set<string>(BASELINE_PROVIDERS);
  for (const [key, value] of Object.entries(collectors)) {
    if (value.enabled === true) set.add(key);
  }
  for (const row of providerAuthRows) {
    set.add(row.provider);
  }
  return Array.from(set).sort();
}

// ---------------------------------------------------------------------------
// Time range helpers
// ---------------------------------------------------------------------------

/**
 * Compute the inclusive `[fromTs, toTs]` bounds for the given range.
 *
 * - `today`: midnight local time to now
 * - `week`: 7 days ago (same time) to now
 * - `month`: 30 days ago (same time) to now
 */
function computeRangeBounds(range: UsageRange, now: number): { fromTs: number; toTs: number } {
  const toTs = now;
  let fromTs: number;

  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      fromTs = d.getTime();
      break;
    }
    case 'week': {
      fromTs = now - 7 * 24 * 60 * 60 * 1000;
      break;
    }
    case 'month': {
      fromTs = now - 30 * 24 * 60 * 60 * 1000;
      break;
    }
  }

  return { fromTs, toTs };
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface UsageService {
  getUsageSummary(input: UsageSummaryInput): UsageSummary;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface UsageServiceDeps {
  usageEvents: UsageEventsRepository;
  settings: SettingsRepository;
  /**
   * Optional. When supplied, every `provider_auth.provider` value is
   * folded into the derived provider set so an imported CPA account
   * surfaces in the usage list even before the matching collector has
   * produced its first event. When absent, the derivation falls back
   * to baseline + collectors only.
   */
  providerAuth?: ProviderAuthRepository;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const getClock = deps.now ?? Date.now;

  return {
    getUsageSummary(input: UsageSummaryInput): UsageSummary {
      const now = getClock();
      const bounds = computeRangeBounds(input.range, now);

      // 1. Query aggregates grouped by provider within the window.
      const aggregates = deps.usageEvents.aggregateByProvider(bounds);
      const aggregateMap = new Map(aggregates.map((a) => [a.provider, a]));

      // 2. Read the last capability results to determine status per provider.
      const capabilityMap = readCapabilityResults(deps.settings);

      // 3. Derive the provider set at query time. Settings are read once
      //    here (rather than threaded through the repository) so the
      //    surrounding aggregation logic remains a pure function of the
      //    `[fromTs, toTs]` window. When `app.settings` is absent (very
      //    early boot before `loadOrSeedAppSettings`) we still fall
      //    back to the baseline.
      const settings = readAppSettings(deps.settings);
      const collectors = settings?.collectors ?? {};
      const providerAuthRows = deps.providerAuth?.list() ?? [];
      const knownProviders = deriveKnownProviders(collectors, providerAuthRows);

      // 4. Build per-provider summaries for all known providers.
      const perProvider: UsageProviderSummary[] = knownProviders.map((provider) => {
        const aggregate = aggregateMap.get(provider) ?? {
          provider,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          costUsd: null,
          eventCount: 0,
        };

        const capResult: CapabilityResult | undefined = capabilityMap[provider];
        const status: CollectorStatus = capResult?.status ?? 'unavailable';
        const reason =
          status !== 'ok' && capResult && 'reason' in capResult
            ? capResult.reason
            : undefined;

        return aggregateToProviderSummary(aggregate, status, reason);
      });

      return {
        range: input.range,
        perProvider,
      };
    },
  };
}
