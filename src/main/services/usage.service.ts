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
  QuotaSnapshot,
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

/**
 * Providers that maintain a local on-disk token log and may therefore
 * legitimately produce `usage_events` even when the user has not
 * imported a `provider_auth` row for them. Surfacing only this small
 * allowlist keeps the unification invariant — arbitrary or unknown
 * provider strings still cannot reach the panel via events alone.
 *
 *   - `claude-code`: `~/.claude/projects/<ws>/<sid>.jsonl` per-message
 *     `message.usage` block.
 *   - `codex`:       `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
 *     `payload.info.last_token_usage` block.
 *   - `kiro-ide`:    `tokens_generated.jsonl` under the per-platform
 *     `Kiro/User/globalStorage/kiro.kiroagent/dev_data/` path.
 */
export const LOCAL_LOG_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'kiro-ide',
]);

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
  /** Getter for current quota snapshots (latest known). */
  quotaSnapshots?: () => QuotaSnapshot[];
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

function parseLocalYMD(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return 0;
  return new Date(y, m - 1, d).getTime();
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

      // 3. Derive the provider set at query time. The unified AI
      //    Accounts plan keeps `provider_auth` as the primary source
      //    of truth — only enabled accounts visible there reach the
      //    summary — so legacy `settings.collectors` toggles never
      //    leak in (planning doc §Renderer UI 设计).
      //
      //    Narrow widening for local-log providers: a small,
      //    explicitly-listed set of providers (Claude Code, Codex,
      //    Kiro IDE) keeps a local JSONL log on disk independent of
      //    any imported credential. Surfacing those from
      //    `usage_events` lets the panel reflect real consumption
      //    when the user signed in to the CLI/IDE but never went
      //    through the CPA auth-file import path. We deliberately
      //    DO NOT widen beyond this list — that would re-open the
      //    "settings toggle leaks unaffiliated providers" hole the
      //    unification closed. A `provider_auth` row with
      //    `enabled: false` still wins: a paused row hides the
      //    provider even when local-log events accumulate.
      const providerAuthRows = deps.providerAuth?.list() ?? [];
      const authProviders = deriveKnownProviders(providerAuthRows);
      const disabledProviders = new Set<string>(
        providerAuthRows.filter((r) => !r.enabled).map((r) => r.provider),
      );
      const eventOnlyProviders = aggregates
        .filter((a) => a.eventCount > 0)
        .map((a) => a.provider)
        .filter(
          (p) => LOCAL_LOG_ONLY_PROVIDERS.has(p) && !disabledProviders.has(p),
        );
      const knownProviders = Array.from(
        new Set<string>([...authProviders, ...eventOnlyProviders]),
      ).sort();

      // Get quota snapshots
      const snapshots = deps.quotaSnapshots?.() ?? [];

      // 4. Build per-provider summaries for all known providers.
      const perProvider: UsageProviderSummary[] = knownProviders.map((provider) => {
        const aggregate = aggregateMap.get(provider);

        const capResult: CapabilityResult | undefined = capabilityMap[provider];
        const status: CollectorStatus = capResult?.status ?? 'unavailable';
        const reason =
          status !== 'ok' && capResult && 'reason' in capResult
            ? capResult.reason
            : undefined;

        if (aggregate && aggregate.eventCount > 0) {
          const hasTokens = (aggregate.inputTokens + aggregate.outputTokens + aggregate.cacheTokens) > 0;
          const summary: UsageProviderSummary = {
            provider,
            status,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            cacheTokens: aggregate.cacheTokens,
            costUsd: aggregate.costUsd,
            eventCount: aggregate.eventCount,
            source: 'events',
            hasTokenBreakdown: hasTokens,
          };
          if (reason !== undefined) {
            summary.reason = reason;
          }
          return summary;
        }

        // Try falling back to quotaSnapshots' dailyUsage
        const providerSnapshots = snapshots.filter((s) => s.provider === provider);
        let totalTokens = 0;
        let totalCost = 0;
        let hasDailyUsage = false;

        for (const snap of providerSnapshots) {
          if (snap.dailyUsage && Array.isArray(snap.dailyUsage)) {
            for (const point of snap.dailyUsage) {
              const ptTs = parseLocalYMD(point.date);
              if (ptTs >= bounds.fromTs && ptTs <= bounds.toTs) {
                hasDailyUsage = true;
                totalTokens += point.totalTokens ?? 0;
                totalCost += point.cost ? parseFloat(point.cost) : 0;
              }
            }
          }
        }

        if (hasDailyUsage) {
          const summary: UsageProviderSummary = {
            provider,
            status,
            inputTokens: totalTokens,
            outputTokens: 0,
            cacheTokens: 0,
            costUsd: totalCost > 0 ? totalCost : null,
            eventCount: 0,
            source: 'quotaDailyUsage',
            hasTokenBreakdown: false,
          };
          if (reason !== undefined) {
            summary.reason = reason;
          }
          return summary;
        }

        const summary: UsageProviderSummary = {
          provider,
          status,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          costUsd: null,
          eventCount: 0,
          source: 'none',
          hasTokenBreakdown: false,
        };
        if (reason !== undefined) {
          summary.reason = reason;
        }
        return summary;
      });

      return {
        range: input.range,
        perProvider,
      };
    },
  };
}
