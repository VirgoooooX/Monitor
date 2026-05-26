// Usage aggregation service.
//
// References:
//   - design.md §Data Models §UsageSummary, §Performance Considerations
//   - cpa-quota-import/design.md §Dynamic KNOWN_PROVIDERS
//   - cpa-quota-import/requirements.md Requirement 14.1, 14.2, 14.4
//   - PLAN.md §SQLite Schema §聚合结果
//   - planning doc "统一 AI 账号来源" §Renderer UI 设计
//
// Computes today/week/month aggregates at query time over `usage_events`
// (no materialization in v1). Returns per-provider rows with `status`,
// totals, `eventCount`, and `reason` when status is not `ok`.
//
// `KNOWN_PROVIDERS` is no longer hardcoded and the legacy
// `settings.collectors` map is intentionally ignored (per the AI
// Accounts unification plan): the visible provider set is derived
// purely from the `provider_auth` rows whose `enabled === true`.
// Disabled rows are filtered out so a paused account disappears from
// the usage summary without losing its row in the settings list.

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
import { aggregateToProviderSummary } from '../store/repositories';
import { readCapabilityResults } from '../collectors/usage/Collector';

// ---------------------------------------------------------------------------
// Known providers
// ---------------------------------------------------------------------------

/**
 * Derive the visible provider set for the usage summary.
 *
 * The unified AI Accounts plan ("统一 AI 账号来源、凭据输入与启用
 * 开关") replaces the previous baseline ∪ collectors ∪ provider_auth
 * derivation with a single source of truth: the `provider_auth` rows
 * the user has imported and not paused. Disabled rows drop out of
 * the summary; baseline keys (`codex` / `gemini` / `antigravity` /
 * `opencode` / `deepseek`) are no longer auto-pinned.
 *
 * @param providerAuthRows Rows from `provider_auth.list()`. Disabled
 *   entries are filtered here so the consuming caller does not have
 *   to remember the rule.
 * @returns Sorted, deduplicated list of provider keys.
 */
export function deriveKnownProviders(
  providerAuthRows: ReadonlyArray<{ provider: string; enabled: boolean }>,
): string[] {
  const set = new Set<string>();
  for (const row of providerAuthRows) {
    if (row.enabled) set.add(row.provider);
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
   * Source of truth for the visible provider set. Optional only so
   * very-early-boot test doubles can omit it; production wiring
   * always provides the live repository.
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

      // 3. Derive the provider set at query time from the enabled
      //    `provider_auth` rows. The legacy `settings.collectors`
      //    map is intentionally not consulted — the unified AI
      //    Accounts panel makes per-account `enabled` toggles the
      //    only way a provider becomes visible.
      const providerAuthRows = deps.providerAuth?.list() ?? [];
      const knownProviders = deriveKnownProviders(providerAuthRows);

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
