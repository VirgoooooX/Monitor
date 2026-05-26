// Usage aggregation service.
//
// References:
//   - design.md §Data Models §UsageSummary, §Performance Considerations
//   - PLAN.md §SQLite Schema §聚合结果
//
// Computes today/week/month aggregates at query time over `usage_events`
// (no materialization in v1). Returns per-provider rows with `status`,
// totals, `eventCount`, and `reason` when status is not `ok`.

import type {
  CapabilityResult,
  CollectorStatus,
  UsageProviderSummary,
  UsageRange,
  UsageSummary,
  UsageSummaryInput,
} from '../types';
import type { SettingsRepository, UsageEventsRepository } from '../store/repositories';
import { aggregateToProviderSummary } from '../store/repositories';
import { readCapabilityResults } from '../collectors/usage/Collector';

// ---------------------------------------------------------------------------
// Known providers
// ---------------------------------------------------------------------------

const KNOWN_PROVIDERS = ['codex', 'gemini', 'antigravity', 'opencode', 'deepseek'] as const;

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

      // 3. Build per-provider summaries for all known providers.
      const perProvider: UsageProviderSummary[] = KNOWN_PROVIDERS.map((provider) => {
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
