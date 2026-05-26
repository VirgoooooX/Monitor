// UsagePanel — comprehensive AI usage + quota dashboard.
//
// Displays:
//   1. Quota overview with progress bars (5h/weekly windows)
//   2. Token consumption breakdown by provider
//   3. Per-provider detail cards with input/output/cache split
//
// References:
//   - tokscale: subscription usage tab with progress bars + reset time
//   - codex-monitor: rolling 5h window + 5-min slot heatmap
//   - PLAN.md §AI Usage Collectors

import { useEffect, useState, useCallback } from 'react';

import { formatTokens } from '../lib/format';
import type {
  CollectorStatus,
  QuotaSnapshot,
  QuotaStatus,
  QuotaWindow,
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
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(status: CollectorStatus): string {
  switch (status) {
    case 'ok': return '正常';
    case 'degraded': return '降级';
    case 'unavailable': return '不可用';
    case 'disabled': return '已禁用';
  }
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '—';
  return `$${costUsd.toFixed(2)}`;
}

function formatResetTime(resetAt: number | null): string {
  if (resetAt === null) return '—';
  const now = Date.now();
  const diff = resetAt - now;
  if (diff <= 0) return '即将重置';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}天 ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function quotaBarClass(percentLeft: number | null): string {
  if (percentLeft === null) return 'quota-bar--unknown';
  // Color by remaining: lots left = green, getting low = orange, nearly out = red.
  if (percentLeft <= 20) return 'quota-bar--critical';
  if (percentLeft <= 50) return 'quota-bar--warn';
  return 'quota-bar--ok';
}

function windowDisplayName(name: string): string {
  switch (name) {
    case '5h': return '5 小时窗口';
    case 'weekly': return '每周配额';
    case 'monthly': return '每月配额';
    case 'daily': return '每日配额';
    default: return name;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsagePanel(): JSX.Element {
  const [range, setRange] = useState<UsageRange>('today');
  const [usageData, setUsageData] = useState<UsageSummary | null>(null);
  const [quotaData, setQuotaData] = useState<QuotaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch usage data
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
          setUsageData(summary);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch usage data');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [range]);

  // Fetch quota data
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop || !('getQuotaStatus' in desktop)) return;

    let cancelled = false;

    desktop
      .getQuotaStatus()
      .then((status) => {
        if (!cancelled) setQuotaData(status);
      })
      .catch(() => {
        // Non-fatal — quota display is optional
      });

    // Refresh quota every 60s
    const interval = setInterval(() => {
      desktop
        .getQuotaStatus()
        .then((status) => {
          if (!cancelled) setQuotaData(status);
        })
        .catch(() => {});
    }, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <section className="usage-panel-v2" data-testid="usage-panel" aria-label="AI 用量面板">
      {error && (
        <div className="usage-panel-v2__error" role="alert">{error}</div>
      )}

      {/* Quota Overview Section */}
      {quotaData && quotaData.snapshots.length > 0 && (
        <QuotaOverview snapshots={quotaData.snapshots} />
      )}

      {/* Range tabs + summary */}
      <div className="usage-panel-v2__header">
        <h2 className="usage-panel-v2__title">Token 消耗</h2>
        <div className="usage-panel-v2__tabs" role="tablist" aria-label="时间范围">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="tab"
              aria-selected={range === opt.value}
              className={`usage-panel-v2__tab${range === opt.value ? ' usage-panel-v2__tab--active' : ''}`}
              onClick={() => setRange(opt.value)}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Totals summary bar */}
      {usageData && <TotalsSummary providers={usageData.perProvider} />}

      {/* Loading state */}
      {loading && !usageData && (
        <p className="usage-panel-v2__loading" aria-live="polite">加载中…</p>
      )}

      {/* Provider detail cards */}
      {usageData && (
        <div className="usage-panel-v2__grid">
          {usageData.perProvider.map((provider) => (
            <ProviderCard key={provider.provider} provider={provider} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quota Overview
// ---------------------------------------------------------------------------

function QuotaOverview({ snapshots }: { snapshots: QuotaSnapshot[] }): JSX.Element {
  return (
    <div className="quota-overview">
      <h2 className="quota-overview__title">配额状态</h2>
      <div className="quota-overview__list">
        {snapshots.map((snapshot) =>
          snapshot.windows.map((window, i) => (
            <QuotaBar
              key={`${snapshot.provider}-${window.name}-${i}`}
              provider={snapshot.provider}
              window={window}
              source={snapshot.source}
              capturedAt={snapshot.capturedAt}
            />
          )),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quota progress bar
// ---------------------------------------------------------------------------

interface QuotaBarProps {
  provider: string;
  window: QuotaWindow;
  source: 'local_log' | 'remote_api';
  capturedAt: number;
}

function QuotaBar({ provider, window: w, source, capturedAt }: QuotaBarProps): JSX.Element {
  // The bar is filled by *remaining* quota: a full green bar means
  // plenty left, an empty bar means nearly exhausted. The color
  // ramp (`quotaBarClass`) is keyed off the same remaining value.
  const remaining = w.percentLeft;
  const barClass = quotaBarClass(remaining);
  const staleMs = Date.now() - capturedAt;
  const isStale = staleMs > 10 * 60 * 1000; // > 10 min

  return (
    <div className={`quota-bar ${barClass}`} aria-label={`${provider} ${w.name} 配额`}>
      <div className="quota-bar__header">
        <span className="quota-bar__provider">
          {provider.charAt(0).toUpperCase() + provider.slice(1)}
        </span>
        <span className="quota-bar__window-name">{windowDisplayName(w.name)}</span>
        <span className="quota-bar__source" title={source === 'remote_api' ? '来自官方 API' : '来自本地日志'}>
          {source === 'remote_api' ? '●' : '○'}
        </span>
      </div>

      <div className="quota-bar__track">
        <div
          className="quota-bar__fill"
          style={{ width: `${Math.min(remaining ?? 0, 100)}%` }}
          aria-valuenow={remaining ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>

      <div className="quota-bar__footer">
        <span className="quota-bar__percent">
          {w.percentLeft !== null ? `剩余 ${w.percentLeft.toFixed(0)}%` : '未知'}
        </span>
        <span className="quota-bar__reset">
          重置: {formatResetTime(w.resetAt)}
        </span>
        {isStale && (
          <span className="quota-bar__stale" title="数据可能不是最新的">⏱</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals summary
// ---------------------------------------------------------------------------

function TotalsSummary({ providers }: { providers: UsageProviderSummary[] }): JSX.Element {
  const totalInput = providers.reduce((s, p) => s + p.inputTokens, 0);
  const totalOutput = providers.reduce((s, p) => s + p.outputTokens, 0);
  const totalCache = providers.reduce((s, p) => s + p.cacheTokens, 0);
  const totalTokens = totalInput + totalOutput + totalCache;
  const totalCost = providers.reduce((s, p) => s + (p.costUsd ?? 0), 0);
  const totalEvents = providers.reduce((s, p) => s + p.eventCount, 0);

  return (
    <div className="usage-totals">
      <div className="usage-totals__item">
        <span className="usage-totals__value">{formatTokens(totalTokens)}</span>
        <span className="usage-totals__label">总 Tokens</span>
      </div>
      <div className="usage-totals__item">
        <span className="usage-totals__value">{formatCost(totalCost > 0 ? totalCost : null)}</span>
        <span className="usage-totals__label">预估费用</span>
      </div>
      <div className="usage-totals__item">
        <span className="usage-totals__value">{totalEvents}</span>
        <span className="usage-totals__label">请求数</span>
      </div>
      <div className="usage-totals__item usage-totals__item--breakdown">
        <span className="usage-totals__mini">
          In {formatTokens(totalInput)} · Out {formatTokens(totalOutput)} · Cache {formatTokens(totalCache)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider detail card
// ---------------------------------------------------------------------------

function ProviderCard({ provider }: { provider: UsageProviderSummary }): JSX.Element {
  const totalTokens = provider.inputTokens + provider.outputTokens + provider.cacheTokens;
  const isActive = provider.status === 'ok' || provider.status === 'degraded';

  return (
    <div
      className={`provider-card provider-card--${provider.status}`}
      data-testid={`provider-card-${provider.provider}`}
    >
      {/* Header */}
      <div className="provider-card__header">
        <span className="provider-card__name">
          {provider.provider.charAt(0).toUpperCase() + provider.provider.slice(1)}
        </span>
        <span className={`provider-card__badge provider-card__badge--${provider.status}`}>
          {statusLabel(provider.status)}
        </span>
      </div>

      {isActive ? (
        <>
          {/* Token breakdown */}
          <div className="provider-card__breakdown">
            <TokenRow label="Input" value={provider.inputTokens} total={totalTokens} color="var(--color-input)" />
            <TokenRow label="Output" value={provider.outputTokens} total={totalTokens} color="var(--color-output)" />
            <TokenRow label="Cache" value={provider.cacheTokens} total={totalTokens} color="var(--color-cache)" />
          </div>

          {/* Totals */}
          <div className="provider-card__footer">
            <div className="provider-card__stat">
              <span className="provider-card__stat-value">{formatTokens(totalTokens)}</span>
              <span className="provider-card__stat-label">合计</span>
            </div>
            {provider.costUsd !== null && (
              <div className="provider-card__stat">
                <span className="provider-card__stat-value">{formatCost(provider.costUsd)}</span>
                <span className="provider-card__stat-label">费用</span>
              </div>
            )}
            <div className="provider-card__stat">
              <span className="provider-card__stat-value">{provider.eventCount}</span>
              <span className="provider-card__stat-label">请求</span>
            </div>
          </div>
        </>
      ) : (
        <div className="provider-card__inactive">
          {provider.reason && (
            <p className="provider-card__reason">{provider.reason}</p>
          )}
          {provider.status === 'disabled' && (
            <p className="provider-card__hint">在设置中启用后可显示用量数据</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token row with proportion bar
// ---------------------------------------------------------------------------

interface TokenRowProps {
  label: string;
  value: number;
  total: number;
  color: string;
}

function TokenRow({ label, value, total, color }: TokenRowProps): JSX.Element {
  const percent = total > 0 ? (value / total) * 100 : 0;

  return (
    <div className="token-row">
      <span className="token-row__label">{label}</span>
      <div className="token-row__bar-track">
        <div
          className="token-row__bar-fill"
          style={{ width: `${percent}%`, backgroundColor: color }}
        />
      </div>
      <span className="token-row__value">{formatTokens(value)}</span>
    </div>
  );
}
