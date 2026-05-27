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
import {
  groupQuotaWindowsByDisplay,
  quotaWindowDisplayName,
  quotaWindowPriority,
} from '../lib/quota-display';
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

function formatClock(timestamp: number | null): string {
  if (timestamp === null) return '—';
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatPercent(percentLeft: number | null): string {
  if (percentLeft === null) return '—';
  return `${Math.round(percentLeft)}%`;
}

function clampPercent(percentLeft: number | null): number {
  if (percentLeft === null) return 0;
  return Math.min(Math.max(percentLeft, 0), 100);
}

function quotaWindowToneClass(percentLeft: number | null): string {
  if (percentLeft === null) return 'quota-window-row--unknown';
  // Color by remaining: lots left = green, getting low = orange, nearly out = red.
  if (percentLeft <= 20) return 'quota-window-row--critical';
  if (percentLeft <= 50) return 'quota-window-row--warn';
  return 'quota-window-row--ok';
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'codex': return 'Codex';
    case 'claude-code': return 'Claude Code';
    case 'gemini-cli': return 'Gemini CLI';
    case 'antigravity': return 'Antigravity';
    case 'gemini-api': return 'Gemini API';
    case 'deepseek-api': return 'DeepSeek';
    case 'openai-compatible': return 'OpenAI Compat';
    case 'xiaomi-cloud': return 'Xiaomi';
    default: return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function providerTone(provider: string): string {
  return provider.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function sourceDisplayName(source: QuotaSnapshot['source']): string {
  switch (source) {
    case 'imported_auth': return 'CPA 文件';
    case 'remote_api': return '官方 API';
    case 'local_log': return '本地日志';
    case 'health_check': return '健康检查';
  }
}

function snapshotTitle(snapshot: QuotaSnapshot): string {
  return (
    snapshot.accountLabel?.trim() ||
    snapshot.projectId?.trim() ||
    snapshot.accountId?.trim() ||
    providerDisplayName(snapshot.provider)
  );
}

function compactIdentifier(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 28) return value;
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function snapshotMeta(snapshot: QuotaSnapshot): string {
  const title = snapshotTitle(snapshot);
  const parts: string[] = [];
  if (snapshot.projectId && snapshot.projectId !== title) {
    parts.push(`项目 ${compactIdentifier(snapshot.projectId) ?? snapshot.projectId}`);
  }
  if (snapshot.accountId && snapshot.accountId !== title) {
    parts.push(`账号 ${compactIdentifier(snapshot.accountId) ?? snapshot.accountId}`);
  }
  parts.push(sourceDisplayName(snapshot.source));
  return parts.join(' · ');
}

function snapshotStatusLabel(snapshot: QuotaSnapshot): string {
  if (snapshot.lastErrorCode === 'auth_expired') return '凭据过期';
  if (snapshot.lastErrorCode === 'upstream_unauthorized') return '上游拒绝';
  if (snapshot.lastErrorCode === 'rate_limited') return '请求过快';
  if (snapshot.status === 'stale') return '上次结果';
  if (snapshot.status === 'unavailable') return '不可用';
  if (snapshot.status === 'unsupported') return '暂未实现';
  return '官方额度';
}

function snapshotStatusTone(snapshot: QuotaSnapshot): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (snapshot.status === 'ok' && snapshot.lastErrorCode == null) return 'ok';
  if (snapshot.status === 'stale') return 'warn';
  if (snapshot.status === 'unsupported') return 'neutral';
  return 'bad';
}

function planLabelPrefix(provider: string): string {
  return provider === 'gemini-cli' || provider === 'antigravity' ? '层级' : '套餐';
}

function providerPriority(provider: string): number {
  switch (provider) {
    case 'codex': return 0;
    case 'claude-code': return 1;
    case 'gemini-cli': return 2;
    case 'antigravity': return 3;
    default: return 10;
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
  const orderedSnapshots = [...snapshots].sort((a, b) => {
    const providerOrder = providerPriority(a.provider) - providerPriority(b.provider);
    if (providerOrder !== 0) return providerOrder;
    return snapshotTitle(a).localeCompare(snapshotTitle(b), 'zh-CN');
  });

  return (
    <div className="quota-overview">
      <div className="quota-overview__header">
        <h2 className="quota-overview__title">
          配额状态
          <span className="quota-overview__count">{snapshots.length}</span>
        </h2>
        <span className="quota-overview__mode">按账号显示</span>
      </div>
      <div className="quota-overview__grid">
        {orderedSnapshots.map((snapshot, i) => (
          <QuotaAccountCard
            key={snapshot.providerAuthId ?? `${snapshot.provider}-${snapshot.accountId ?? snapshot.projectId ?? i}`}
            snapshot={snapshot}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quota account card
// ---------------------------------------------------------------------------

function QuotaAccountCard({ snapshot }: { snapshot: QuotaSnapshot }): JSX.Element {
  // Group raw windows by display label so callers see at most one row
  // per group (e.g. Claude 4.6 = Opus + Sonnet averaged). Sorted by
  // `quotaWindowPriority` inside the helper.
  const windows = groupQuotaWindowsByDisplay(snapshot.windows, snapshot.provider);
  const title = snapshotTitle(snapshot);
  const tone = snapshotStatusTone(snapshot);

  return (
    <article
      className="quota-account-card"
      data-provider={providerTone(snapshot.provider)}
      data-status={tone}
      aria-label={`${providerDisplayName(snapshot.provider)} ${title} 配额`}
    >
      <header className="quota-account-card__header">
        <div className="quota-account-card__identity">
          <span className="quota-account-card__chip">
            {providerDisplayName(snapshot.provider)}
          </span>
          <div className="quota-account-card__copy">
            <h3 className="quota-account-card__name" title={title}>{title}</h3>
            <span className="quota-account-card__meta" title={`刷新 ${formatClock(snapshot.capturedAt)}`}>
              {snapshotMeta(snapshot)}
            </span>
          </div>
        </div>
        <span className="quota-account-card__status" data-tone={tone}>
          {snapshotStatusLabel(snapshot)}
        </span>
      </header>

      {snapshot.rawPlanLabel && (
        <div className="quota-account-card__plan">
          <span>{planLabelPrefix(snapshot.provider)}</span>
          <strong>{snapshot.rawPlanLabel}</strong>
        </div>
      )}

      <div className="quota-account-card__windows">
        {windows.length > 0 ? (
          windows.map(({ window, displayName }, i) => (
            <QuotaWindowRow
              key={`${window.name}-${i}`}
              window={window}
              displayName={displayName}
            />
          ))
        ) : (
          <p className="quota-account-card__empty">暂无可显示额度</p>
        )}
      </div>

      {snapshot.lastErrorMessage && (
        <p className="quota-account-card__notice" data-tone={tone}>
          {snapshot.lastErrorMessage}
        </p>
      )}
    </article>
  );
}

function QuotaWindowRow({
  window: w,
  displayName,
}: {
  window: QuotaWindow;
  displayName: string;
}): JSX.Element {
  const remaining = w.percentLeft;
  const rowClass = quotaWindowToneClass(remaining);

  return (
    <div className={`quota-window-row ${rowClass}`} aria-label={`${displayName} 剩余 ${formatPercent(remaining)}`}>
      <span className="quota-window-row__label" title={displayName}>{displayName}</span>
      <span className="quota-window-row__numbers">
        <strong className="quota-window-row__percent">{formatPercent(remaining)}</strong>
        <span className="quota-window-row__reset">{formatClock(w.resetAt)}</span>
      </span>
      <div className="quota-window-row__track">
        <div
          className="quota-window-row__fill"
          style={{ width: `${clampPercent(remaining)}%` }}
          aria-valuenow={remaining ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
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
