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
  parseCreditsWindow,
  currencySymbol,
} from '../lib/quota-display';
import { UsageSparkline } from './QuotaStrip';
import { ProviderIcon } from './ProviderIcon';
import { PROVIDER_LABELS, providerIconKey, maskedEmailLabel } from './ProviderAuthList';
import type {
  CollectorStatus,
  QuotaSnapshot,
  QuotaStatus,
  QuotaWindow,
  UsageProviderSummary,
  UsageRange,
  UsageSummary,
  ProviderId,
  ProviderAuthMetadata,
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
    case 'kiro-ide': return 'Kiro IDE';
    case 'gemini-api': return 'Gemini API';
    case 'deepseek': return 'DeepSeek';
    case 'openai-compatible': return 'OpenAI Compat';
    case 'xiaomi': return 'Xiaomi';
    default: return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function providerTone(provider: string): string {
  return provider.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function sourceDisplayName(source: QuotaSnapshot['source']): string {
  switch (source) {
    case 'imported_auth': return 'auth 认证';
    case 'remote_api': return '官方 API';
    case 'local_log': return '本地日志';
    case 'health_check': return '健康检查';
  }
}

function cleanAccountLabel(label: string, provider: string): string {
  let cleaned = label.trim();

  // 1. Strip the auto-discovery suffix so downstream pattern checks
  //    (placeholder detection, email extraction, UUID shortening) all
  //    operate on the "core" label. The suffix carries no identity
  //    signal — it just records that the row was found by the
  //    auto-discovery scan rather than picked from the file dialog —
  //    so dropping it before pattern matching is purely simplifying.
  if (cleaned.endsWith(' (自动发现)')) {
    cleaned = cleaned.slice(0, -' (自动发现)'.length).trim();
  }

  // 2. Strip common suffixes (like .json)
  if (cleaned.endsWith('.json')) {
    cleaned = cleaned.slice(0, -5);
  }

  // 3. Strip common prefixes based on provider
  if (provider === 'gemini-cli') {
    cleaned = cleaned.replace(/^Gemini CLI\s*\(([^)]+)\)$/i, '$1');
  } else if (provider === 'antigravity') {
    cleaned = cleaned.replace(/^Antigravity\s*\(([^)]+)\)$/i, '$1');
  }

  // Generic prefix strip
  cleaned = cleaned.replace(/^(codex_oauth_|claude_code_oauth_|gemini_cli_|antigravity_|deepseek_)/, '');

  // 4. Try to extract email from the remaining part
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const match = emailRegex.exec(cleaned);
  if (match) {
    return match[0];
  }

  // 5. If it is a UUID (like 37957071-dbb0-48c4-a120-2f50829dc2c9)
  const uuidRegex = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  const uuidMatch = uuidRegex.exec(cleaned);
  if (uuidMatch) {
    const uuid = uuidMatch[0];
    const shortened = `${uuid.slice(0, 8)}...${uuid.slice(-5)}`;
    return cleaned.replace(uuid, shortened);
  }

  return cleaned;
}

/**
 * The CPA auth-file parser falls back to `<provider>:imported`
 * (e.g. `kiro-ide:imported`) when it cannot derive an email or
 * accountId from the file. The auto-discovery scanner then appends
 * ` (自动发现)`. That fallback string carries no identity — it is
 * just "we have a row and nothing to call it" — so the quota card
 * subtitle should hide it instead of rendering a noisy
 * `KIRO-IDE:IMPORTED` chip next to the plan label.
 *
 * Matches both the bare fallback (`<id>:imported`, any case) and
 * the UPPERCASE form some files ship with (`KIRO-IDE:IMPORTED`).
 * The `(自动发现)` suffix is stripped upstream by
 * {@link cleanAccountLabel} so we only need the colon-pattern here.
 */
function isParserPlaceholderLabel(cleaned: string): boolean {
  return /^[a-z0-9-]+:imported$/i.test(cleaned.trim());
}

function snapshotTitle(snapshot: QuotaSnapshot): string {
  const rawTitle = (
    snapshot.accountLabel?.trim() ||
    snapshot.projectId?.trim() ||
    snapshot.accountId?.trim() ||
    providerDisplayName(snapshot.provider)
  );
  return cleanAccountLabel(rawTitle, snapshot.provider);
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
  if (snapshot.status === 'stale') return '使用上次结果';
  if (snapshot.status === 'unavailable') return '不可用';
  if (snapshot.status === 'unsupported') return '暂不支持';
  return '正常';
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
    case 'kiro-ide': return 4;
    case 'opencode': return 5;
    case 'deepseek': return 6;
    case 'xiaomi': return 7;
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
  const [providerAuths, setProviderAuths] = useState<ProviderAuthMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch usage data — initial pull on `range` change, then refresh
  // every 60 s so newly-collected `usage_events` reach the panel
  // without the user having to flip the range tab. Also re-runs
  // when a `provider-auth.updated` push arrives, since adding /
  // pausing an account changes which providers the summary shows.
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      setError('preload bridge unavailable');
      return;
    }

    let cancelled = false;
    let firstFetch = true;

    const fetchUsage = (): void => {
      // Show the spinner only on the first fetch for this range —
      // background refresh ticks should not flash the loading
      // state and unmount the cards.
      if (firstFetch) {
        setLoading(true);
        firstFetch = false;
      }
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
    };

    fetchUsage();
    const interval = setInterval(fetchUsage, 60_000);

    // Refetch on provider-auth pushes (account add / delete / refresh)
    // because the visible provider set is derived in part from
    // `provider_auth` rows.
    let unsubscribe: (() => void) | undefined;
    if ('on' in desktop && typeof desktop.on === 'function') {
      try {
        unsubscribe = desktop.on('provider-auth.updated', () => {
          if (!cancelled) fetchUsage();
        });
      } catch {
        // No-op — the 60s interval still drives updates.
      }
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (unsubscribe) unsubscribe();
    };
  }, [range]);

  // Fetch quota data & provider auths
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) return;

    let cancelled = false;

    if ('getQuotaStatus' in desktop) {
      desktop
        .getQuotaStatus()
        .then((status) => {
          if (!cancelled) setQuotaData(status);
        })
        .catch(() => {});
    }

    if ('listProviderAuths' in desktop) {
      desktop
        .listProviderAuths()
        .then((rows) => {
          if (!cancelled) setProviderAuths(rows);
        })
        .catch(() => {});
    }

    // Refresh quota every 60s
    const interval = setInterval(() => {
      if ('getQuotaStatus' in desktop) {
        desktop
          .getQuotaStatus()
          .then((status) => {
            if (!cancelled) setQuotaData(status);
          })
          .catch(() => {});
      }
    }, 60_000);

    // Subscribe to provider-auth push events so add/delete/refresh
    // is reflected in the usage panel within a single round-trip.
    let unsubscribe: (() => void) | undefined;
    if ('on' in desktop && typeof desktop.on === 'function') {
      try {
        unsubscribe = desktop.on('provider-auth.updated', (payload) => {
          if (!cancelled) {
            if (payload?.quotaStatus !== undefined) {
              setQuotaData(payload.quotaStatus);
            }
            if (payload?.rows !== undefined) {
              setProviderAuths([...payload.rows]);
            }
          }
        });
      } catch {
        // Ignore — polling tick remains as the fallback.
      }
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (unsubscribe) unsubscribe();
    };
  }, []);

  return (
    <section className="usage-panel-v2" data-testid="usage-panel" aria-label="AI 用量面板">
      {error && (
        <div className="usage-panel-v2__error" role="alert">{error}</div>
      )}

      {/* Quota Overview Section */}
      {quotaData && quotaData.snapshots.length > 0 && (
        <QuotaOverview snapshots={quotaData.snapshots} providerAuths={providerAuths} />
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
      {usageData && (() => {
        const visibleProviders = usageData.perProvider.filter(
          (p) =>
            p.inputTokens + p.outputTokens + p.cacheTokens > 0 ||
            p.eventCount > 0 ||
            p.source === 'quotaDailyUsage'
        );

        if (visibleProviders.length === 0) {
          return (
            <div className="usage-panel-v2__empty-state">
              <h3 className="usage-panel-v2__empty-title">暂无 Token 记录</h3>
              <p className="usage-panel-v2__empty-desc">已开始采集，下一次刷新后会显示本地日志或官方日用量。</p>
            </div>
          );
        }

        return (
          <div className="usage-panel-v2__grid">
            {visibleProviders.map((provider) => (
              <ProviderCard key={provider.provider} provider={provider} />
            ))}
          </div>
        );
      })()}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quota Overview
// ---------------------------------------------------------------------------

function QuotaOverview({
  snapshots,
  providerAuths,
}: {
  snapshots: QuotaSnapshot[];
  providerAuths: ProviderAuthMetadata[];
}): JSX.Element {
  const orderedSnapshots = [...snapshots].sort((a, b) => {
    const toneA = snapshotStatusTone(a);
    const toneB = snapshotStatusTone(b);
    const score = (t: string) => {
      if (t === 'ok') return 0;
      if (t === 'warn') return 1;
      if (t === 'neutral') return 2;
      return 3;
    };
    const toneDiff = score(toneA) - score(toneB);
    if (toneDiff !== 0) return toneDiff;

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
        <span className="quota-overview__mode">{snapshots.length} 个账号</span>
      </div>
      <div className="quota-overview__grid">
        {orderedSnapshots.map((snapshot, i) => (
          <QuotaAccountCard
            key={snapshot.providerAuthId ?? `${snapshot.provider}-${snapshot.accountId ?? snapshot.projectId ?? i}`}
            snapshot={snapshot}
            providerAuths={providerAuths}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quota account card
// ---------------------------------------------------------------------------

function QuotaAccountCard({
  snapshot,
  providerAuths,
}: {
  snapshot: QuotaSnapshot;
  providerAuths: ProviderAuthMetadata[];
}): JSX.Element {
  const windows = groupQuotaWindowsByDisplay(snapshot.windows, snapshot.provider);
  const tone = snapshotStatusTone(snapshot);
  const providerLabel = PROVIDER_LABELS[snapshot.provider as ProviderId] ?? providerDisplayName(snapshot.provider);

  // Find credential type
  let typeLabel = '';
  if (snapshot.providerAuthId) {
    const matched = providerAuths.find((p) => p.id === snapshot.providerAuthId);
    if (matched) {
      typeLabel = matched.source === 'cpa-auth-file' ? 'auth 认证' : '手动 API Key';
    }
  }
  const typeText = typeLabel || sourceDisplayName(snapshot.source);

  // Determine unique identifier to display in the second line.
  //
  // Pipeline:
  //   1. `cleanAccountLabel` strips known prefixes (`codex_oauth_`,
  //      `claude_code_oauth_`, `gemini_cli_`, …), `.json` suffix,
  //      and any `<provider> (...)` wrapper, then either extracts
  //      an embedded email or shortens UUIDs.
  //   2. If the cleaned value is itself email-shaped (which is the
  //      common case after step 1), mask the local part for display.
  //   3. Reject generic placeholder labels ("API Key", "imported",
  //      bare provider name) so we don't render redundant chips.
  //   4. Fall through to `projectId` / `accountId` only as a last
  //      resort. For Gemini Code Assist for individuals (which is
  //      what the CPA `gemini-cli` / `antigravity` flow imports)
  //      quotas are metered per account, not per project, so a
  //      surfaced project_id signals that the email enrichment
  //      hasn't reached this row yet (network failure, or a row
  //      imported before enrichment landed and not yet re-scanned).
  //
  // Each branch carries a `kind` so the renderer can prefix
  // project / account ids with a 项目 / 账号 hint (a bare
  // `vivid-course-453615-u9` looks like a status code without it),
  // while emails and human-readable labels render verbatim.
  type UniqueIdKind = 'email' | 'project' | 'account' | 'label';
  let uniqueId: { kind: UniqueIdKind; text: string } | null = null;
  if (snapshot.accountLabel) {
    const cleaned = cleanAccountLabel(snapshot.accountLabel, snapshot.provider);
    const lowerCleaned = cleaned.toLowerCase();
    const lowerProvider = providerLabel.toLowerCase();
    const isGenericKey =
      lowerCleaned === `${lowerProvider} api key` ||
      lowerCleaned === 'api key' ||
      lowerCleaned === 'apikey' ||
      lowerCleaned === 'imported' ||
      lowerCleaned === `${snapshot.provider.toLowerCase()} api key`;
    const isExactProvider =
      lowerCleaned === lowerProvider ||
      lowerCleaned === snapshot.provider.toLowerCase();
    // The parser fallback (`<provider>:imported`, e.g. `kiro-ide:imported`)
    // also lands here when the file carried no email or accountId. It
    // is no more informative than the generic placeholders above, so
    // suppress it from the subtitle.
    const isParserPlaceholder = isParserPlaceholderLabel(cleaned);
    if (!isGenericKey && !isExactProvider && !isParserPlaceholder) {
      const masked = maskedEmailLabel(cleaned);
      if (masked !== null) {
        uniqueId = { kind: 'email', text: masked };
      } else if (snapshot.projectId && cleaned === snapshot.projectId) {
        // The label was derived from the project id (e.g. an old
        // `Gemini CLI (vivid-course-453615-u9)` wrapper that
        // `cleanAccountLabel` unwrapped). Promote it to kind='project'
        // so the renderer can prefix it with 项目, otherwise the
        // bare GCP slug reads like a status code under the parent
        // `text-transform: uppercase` rule.
        uniqueId = { kind: 'project', text: cleaned };
      } else if (snapshot.accountId && cleaned === snapshot.accountId) {
        uniqueId = { kind: 'account', text: cleaned };
      } else {
        uniqueId = { kind: 'label', text: cleaned };
      }
    }
  }

  if (uniqueId === null) {
    if (snapshot.projectId) {
      uniqueId = { kind: 'project', text: snapshot.projectId };
    } else if (snapshot.accountId) {
      uniqueId = {
        kind: 'account',
        text: cleanAccountLabel(snapshot.accountId, snapshot.provider),
      };
    }
  }

  // The aria-label / unique-id rendering mirror the same hint copy.
  const uniqueIdAriaText =
    uniqueId === null
      ? ''
      : uniqueId.kind === 'project'
        ? `项目 ${uniqueId.text}`
        : uniqueId.kind === 'account'
          ? `账号 ${uniqueId.text}`
          : uniqueId.text;

  return (
    <article
      className="quota-account-card"
      data-provider={providerTone(snapshot.provider)}
      data-status={tone}
      aria-label={`${providerLabel} ${uniqueIdAriaText} 配额`}
    >
      {/* 1. 顶部身份区 */}
      <header className="quota-account-card__header">
        <div className="quota-account-card__identity">
          <div className="quota-account-card__icon-wrap">
            <ProviderIcon provider={providerIconKey(snapshot.provider as ProviderId)} size={28} />
          </div>
          <div className="quota-account-card__title-group">
            <h3 className="quota-account-card__name" title={providerLabel}>{providerLabel}</h3>
            <span className="quota-account-card__provider-label" data-provider={providerTone(snapshot.provider)}>
              {typeText}
              {snapshot.kind !== 'credits' && snapshot.rawPlanLabel && (
                <>
                  {' · '}
                  <span className="quota-account-card__plan">
                    {snapshot.rawPlanLabel}
                  </span>
                </>
              )}
              {uniqueId !== null && (
                <>
                  {' · '}
                  {(uniqueId.kind === 'project' || uniqueId.kind === 'account') && (
                    <span className="quota-account-card__id-hint">
                      {uniqueId.kind === 'project' ? '项目' : '账号'}{' '}
                    </span>
                  )}
                  <span
                    className="quota-account-card__unique-id"
                    data-id-kind={uniqueId.kind}
                    title={uniqueId.text}
                  >
                    {uniqueId.text}
                  </span>
                </>
              )}
            </span>
          </div>
        </div>
        <span className="quota-account-card__status" data-tone={tone}>
          {snapshotStatusLabel(snapshot)}
        </span>
      </header>

      {/* 3. 主内容区 */}
      <div className="quota-account-card__content">
        {snapshot.kind === 'quota' && windows.length > 0 ? (
          <div className="quota-account-card__windows">
            {windows.map(({ window, displayName }, i) => (
              <QuotaWindowRow
                key={`${window.name}-${i}`}
                window={window}
                displayName={displayName}
              />
            ))}
          </div>
        ) : snapshot.kind === 'credits' ? (
          <div className="quota-account-card__credits">
            {windows.map(({ window }, i) => {
              const credits = parseCreditsWindow(window.name);
              if (credits === null) return null;
              const symbol = currencySymbol(credits.currency);
              const amount = credits.total ?? credits.toppedUp ?? credits.granted ?? '—';
              const displayAmount = symbol === '' ? `${amount} ${credits.currency}` : `${symbol}${amount}`;
              const fullName = `${credits.currency} ${[
                credits.total === null ? null : `总额 ${credits.total}`,
                credits.granted === null ? null : `赠金 ${credits.granted}`,
                credits.toppedUp === null ? null : `充值 ${credits.toppedUp}`,
              ].filter(Boolean).join(' / ')}`;
              return (
                <div key={i} className="quota-account-card__credits-row" title={fullName}>
                  <div className="quota-account-card__credits-main">
                    <span className="quota-account-card__credits-value">{displayAmount}</span>
                    <span className="quota-account-card__credits-label">余额</span>
                  </div>
                  {/* Always render the sparkline slot — the component
                      itself draws a placeholder baseline when no
                      daily-usage data is available, keeping the
                      card layout (左边金额 / 右边柱状图) consistent
                      across providers and across "first-import vs.
                      after-data-arrives" states. */}
                  <UsageSparkline
                    dailyUsage={snapshot.dailyUsage ?? null}
                    currencySymbol={symbol}
                    currencyCode={credits.currency}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="quota-account-card__health-only">
            <span className="quota-account-card__health-text">暂无额度数据</span>
          </div>
        )}
      </div>

      {/* 4. 底部提示区 */}
      {snapshot.lastErrorMessage && (
        <p className="quota-account-card__notice" data-tone={tone} title={snapshot.lastErrorMessage}>
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
      <div className="quota-window-row__header-line">
        <span className="quota-window-row__label" title={displayName}>{displayName}</span>
        <span className="quota-window-row__meta">
          <strong className="quota-window-row__percent">{formatPercent(remaining)}</strong>
          {w.resetAt !== null && (
            <span className="quota-window-row__reset"> · {formatClock(w.resetAt)} 重置</span>
          )}
        </span>
      </div>
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

function TotalsSummary({ providers }: { providers: UsageProviderSummary[] }): JSX.Element | null {
  const activeProviders = providers.filter((p) => p.source !== 'none');
  if (activeProviders.length === 0) return null;

  const totalInput = activeProviders.reduce((s, p) => s + p.inputTokens, 0);
  const totalOutput = activeProviders.reduce((s, p) => s + p.outputTokens, 0);
  const totalCache = activeProviders.reduce((s, p) => s + p.cacheTokens, 0);
  const totalTokens = totalInput + totalOutput + totalCache;
  const totalCost = activeProviders.reduce((s, p) => s + (p.costUsd ?? 0), 0);
  const totalEvents = activeProviders.reduce((s, p) => s + p.eventCount, 0);

  if (totalTokens === 0) return null;

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

  return (
    <div
      className={`provider-card provider-card--${provider.status}`}
      data-testid={`provider-card-${provider.provider}`}
    >
      {/* Header */}
      <div className="provider-card__header">
        <span className="provider-card__name">
          {providerDisplayName(provider.provider)}
        </span>
        <span className={`provider-card__badge provider-card__badge--${provider.status}`}>
          {statusLabel(provider.status)}
        </span>
      </div>

      <div className="provider-card__content">
        {provider.source === 'events' && provider.hasTokenBreakdown ? (
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
        ) : provider.source === 'events' && !provider.hasTokenBreakdown ? (
          <>
            <div className="provider-card__no-breakdown">
              <p className="provider-card__no-breakdown-text">已记录请求，暂无 token 字段</p>
            </div>

            <div className="provider-card__footer">
              <div className="provider-card__stat">
                <span className="provider-card__stat-value">{provider.eventCount}</span>
                <span className="provider-card__stat-label">请求</span>
              </div>
              {provider.costUsd !== null && (
                <div className="provider-card__stat">
                  <span className="provider-card__stat-value">{formatCost(provider.costUsd)}</span>
                  <span className="provider-card__stat-label">费用</span>
                </div>
              )}
            </div>
          </>
        ) : provider.source === 'quotaDailyUsage' ? (
          <>
            <div className="provider-card__daily-usage-main">
              <div className="provider-card__daily-usage-value-group">
                <span className="provider-card__daily-usage-value">{formatTokens(provider.inputTokens)}</span>
                <span className="provider-card__daily-usage-label">总 Tokens</span>
              </div>
              <span className="provider-card__source-tag">来自官方日用量</span>
            </div>

            <div className="provider-card__footer">
              {provider.costUsd !== null && (
                <div className="provider-card__stat">
                  <span className="provider-card__stat-value">{formatCost(provider.costUsd)}</span>
                  <span className="provider-card__stat-label">官方费用</span>
                </div>
              )}
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
