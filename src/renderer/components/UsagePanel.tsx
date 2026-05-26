// UsagePanel — expanded-window panel showing per-provider AI usage.
//
// Displays a grid of provider tiles, each with:
//   • Provider name (Codex, Gemini, Antigravity, OpenCode, DeepSeek)
//   • State badge: ok (green), degraded (yellow), unavailable (gray), disabled (dim)
//   • Token totals (input + output + cache combined) for selected range
//   • Reason text when status is not `ok`
//
// The user picks a range via today / this-week / this-month tabs.
//
// References:
//   • design.md §Window Strategy
//   • PLAN.md §UI Implementation Guide §AI 用量

import { useEffect, useState } from 'react';

import { formatTokens } from '../lib/format';
import type {
  CollectorStatus,
  UsageProviderSummary,
  UsageRange,
  UsageSummary,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Range selector
// ---------------------------------------------------------------------------

const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
];

// ---------------------------------------------------------------------------
// Badge mapping
// ---------------------------------------------------------------------------

function badgeLabel(status: CollectorStatus): string {
  switch (status) {
    case 'ok':
      return '正常';
    case 'degraded':
      return '降级';
    case 'unavailable':
      return '不可用';
    case 'disabled':
      return '已禁用';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsagePanel(): JSX.Element {
  const [range, setRange] = useState<UsageRange>('today');
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      setError('preload bridge unavailable');
      return;
    }

    let cancelled = false;
    setLoading(true);

    desktop
      .getUsageSummary({ range })
      .then((summary) => {
        if (!cancelled) {
          setData(summary);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : 'Failed to fetch usage data';
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <section
      className="usage-panel"
      data-testid="usage-panel"
      aria-label="AI 用量面板"
    >
      {/* Range selector tabs */}
      <div className="usage-panel__tabs" role="tablist" aria-label="时间范围">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            role="tab"
            aria-selected={range === opt.value}
            className={`usage-panel__tab${range === opt.value ? ' usage-panel__tab--active' : ''}`}
            onClick={() => setRange(opt.value)}
            type="button"
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Content area */}
      {error && (
        <p className="usage-panel__error" role="alert">
          {error}
        </p>
      )}

      {loading && !data && (
        <p className="usage-panel__loading" aria-live="polite">
          加载中…
        </p>
      )}

      {data && (
        <div className="usage-panel__grid" role="list">
          {data.perProvider.map((provider) => (
            <ProviderTile key={provider.provider} provider={provider} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Provider tile
// ---------------------------------------------------------------------------

interface ProviderTileProps {
  readonly provider: UsageProviderSummary;
}

function ProviderTile({ provider }: ProviderTileProps): JSX.Element {
  const totalTokens =
    provider.inputTokens + provider.outputTokens + provider.cacheTokens;

  return (
    <div
      className="usage-tile"
      data-status={provider.status}
      data-testid={`usage-tile-${provider.provider}`}
      role="listitem"
      aria-label={`${provider.provider} 用量`}
    >
      <div className="usage-tile__header">
        <span className="usage-tile__name">{provider.provider}</span>
        <span
          className={`usage-tile__badge usage-tile__badge--${provider.status}`}
          aria-label={`状态: ${badgeLabel(provider.status)}`}
        >
          {badgeLabel(provider.status)}
        </span>
      </div>

      <div className="usage-tile__tokens">
        <span className="usage-tile__total">{formatTokens(totalTokens)}</span>
        <span className="usage-tile__unit">tokens</span>
      </div>

      {provider.status !== 'ok' && provider.reason && (
        <p className="usage-tile__reason">{provider.reason}</p>
      )}
    </div>
  );
}
