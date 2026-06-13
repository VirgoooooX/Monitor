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

import { useEffect, useMemo, useState } from 'react';

import {
  groupQuotaWindowsByDisplay,
  quotaWindowPriority,
  parseCreditsWindow,
  currencySymbol,
  translateQuotaWindowDisplayName,
} from '../lib/quota-display';
import { UsageSparkline } from './QuotaStrip';
import { ProviderIcon } from './ProviderIcon';
import { PROVIDER_LABELS, providerIconKey, maskedEmailLabel } from './ProviderAuthList';
import { UsageBarChart } from './UsageBarChart';
import { formatTokens, formatCurrencyAmount } from '../lib/format';
import { useT } from '../lib/i18n';
import type { Translator, TranslationKey } from '../../i18n';
import type {
  QuotaSnapshot,
  QuotaStatus,
  QuotaWindow,
  UsageRange,
  UsageSummary,
  ProviderId,
  ProviderAuthMetadata,
  ApiUsageBucket,
  ApiUsageSummary,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Range selector
// ---------------------------------------------------------------------------

const RANGE_OPTIONS: { value: UsageRange; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'usage.range.today' },
  { value: 'week', labelKey: 'usage.range.week' },
  { value: 'month', labelKey: 'usage.range.month' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function sourceDisplayName(source: QuotaSnapshot['source'], t: Translator): string {
  switch (source) {
    case 'imported_auth': return t('quota.source.importedAuth');
    case 'remote_api': return t('quota.source.remoteApi');
    case 'local_log': return t('quota.source.localLog');
    case 'health_check': return t('quota.source.healthCheck');
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

function snapshotMeta(snapshot: QuotaSnapshot, t: Translator): string {
  const title = snapshotTitle(snapshot);
  const parts: string[] = [];
  if (snapshot.projectId && snapshot.projectId !== title) {
    parts.push(
      t('usage.identityPrefix.project', {
        value: compactIdentifier(snapshot.projectId) ?? snapshot.projectId,
      }),
    );
  }
  if (snapshot.accountId && snapshot.accountId !== title) {
    parts.push(
      t('usage.identityPrefix.account', {
        value: compactIdentifier(snapshot.accountId) ?? snapshot.accountId,
      }),
    );
  }
  parts.push(sourceDisplayName(snapshot.source, t));
  return parts.join(' · ');
}

function snapshotStatusLabel(snapshot: QuotaSnapshot, t: Translator): string {
  if (snapshot.lastErrorCode === 'auth_expired') return t('quota.snapshot.authExpired');
  if (snapshot.lastErrorCode === 'upstream_unauthorized') return t('quota.snapshot.upstreamRefused');
  if (snapshot.lastErrorCode === 'rate_limited') return t('quota.snapshot.rateLimited');
  if (snapshot.status === 'stale') return t('quota.snapshot.useLastResult');
  if (snapshot.status === 'unavailable') return t('quota.snapshot.unavailable');
  if (snapshot.status === 'unsupported') return t('quota.snapshot.unsupported');
  return t('quota.snapshot.normal');
}

function snapshotStatusTone(snapshot: QuotaSnapshot): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (snapshot.status === 'ok' && snapshot.lastErrorCode == null) return 'ok';
  if (snapshot.status === 'stale') return 'warn';
  if (snapshot.status === 'unsupported') return 'neutral';
  return 'bad';
}

function planLabelPrefix(provider: string, t: Translator): string {
  return provider === 'gemini-cli' || provider === 'antigravity'
    ? t('usage.plan.tier')
    : t('usage.plan.package');
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

/**
 * Convert API usage buckets (ApiUsageBucket[]) to the same
 * UsageTimeseriesBucket[] shape consumed by UsageBarChart.
 * API data has totalTokens → maps to inputTokens.
 * API data has cost + currency → maps to costUsd + currency.
 * outputTokens / cacheTokens / eventCount are always zero.
 */
function apiBucketsToTimeseries(
  apiBuckets: ApiUsageBucket[],
): Array<{
  key: string;
  startTs: number;
  perProvider: Array<{
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number | null;
    eventCount: number;
    currency?: string | null;
  }>;
}> {
  return apiBuckets.map((b) => ({
    key: b.key,
    startTs: b.startTs,
    perProvider: b.perProvider.map((row) => ({
      provider: row.provider,
      inputTokens: row.totalTokens,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: row.cost,
      eventCount: 0,
      currency: row.currency,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsagePanel(): JSX.Element {
  const t = useT();
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
    <section className="usage-panel-v2" data-testid="usage-panel" aria-label={t('usage.panel.aria')}>
      {error && (
        <div className="usage-panel-v2__error" role="alert">{error}</div>
      )}

      {/* Quota Overview Section */}
      {quotaData && quotaData.snapshots.length > 0 && (
        <QuotaOverview snapshots={quotaData.snapshots} providerAuths={providerAuths} />
      )}

      {/* Range tabs + summary */}
      <div className="usage-panel-v2__header">
        <h2 className="usage-panel-v2__title">{t('usage.panel.title')}</h2>
        <div className="usage-panel-v2__tabs" role="tablist" aria-label={t('usage.panel.rangeAria')}>
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="tab"
              aria-selected={range === opt.value}
              className={`usage-panel-v2__tab${range === opt.value ? ' usage-panel-v2__tab--active' : ''}`}
              onClick={() => setRange(opt.value)}
              type="button"
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Local token chart ── */}
      <h3 className="usage-panel-v2__chart-title">{t('usage.chart.localToken')}</h3>
      <UsageBarChart
        buckets={usageData?.buckets ?? []}
        granularity={usageData?.bucketGranularity ?? (range === 'today' ? 'hour' : 'day')}
        providerLabel={(p) =>
          (PROVIDER_LABELS[p as ProviderId] ?? providerDisplayName(p))
        }
      />

      {/* ── API usage chart (mirrors local token chart) ── */}
      {usageData?.apiUsage && (
        <>
          <h3 className="usage-panel-v2__chart-title">{t('usage.chart.apiUsage')}</h3>
          <UsageBarChart
            buckets={apiBucketsToTimeseries(usageData.apiUsage.tokenBuckets)}
            granularity="day"
            providerLabel={(p) =>
              (PROVIDER_LABELS[p as ProviderId] ?? providerDisplayName(p))
            }
          />
        </>
      )}

      {/* ── API usage notices ── */}
      {usageData?.apiUsage && usageData.apiUsage.notices.length > 0 && (
        <div className="api-usage-notices" role="status">
          {usageData.apiUsage.notices.map((notice) => (
            <p
              key={`${notice.provider}-${notice.code}`}
              className="api-usage-notice"
            >
              <strong>
                {PROVIDER_LABELS[notice.provider as ProviderId]
                  ?? providerDisplayName(notice.provider)}
              </strong>
              <span>{notice.message}</span>
            </p>
          ))}
        </div>
      )}

      {/* Loading state */}
      {loading && !usageData && (
        <p className="usage-panel-v2__loading" aria-live="polite">{t('usage.panel.loading')}</p>
      )}
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
  const t = useT();
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
          {t('usage.overview.title')}
          <span className="quota-overview__count">{snapshots.length}</span>
        </h2>
        <span className="quota-overview__mode">
          {t('usage.overview.accountSuffix', { count: snapshots.length })}
        </span>
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
  const t = useT();
  const windows = groupQuotaWindowsByDisplay(snapshot.windows, snapshot.provider);
  const tone = snapshotStatusTone(snapshot);
  const providerLabel = PROVIDER_LABELS[snapshot.provider as ProviderId] ?? providerDisplayName(snapshot.provider);

  // Find credential type
  let typeLabel = '';
  if (snapshot.providerAuthId) {
    const matched = providerAuths.find((p) => p.id === snapshot.providerAuthId);
    if (matched) {
      typeLabel = matched.source === 'cpa-auth-file'
        ? t('usage.account.typeAuth')
        : t('usage.account.typeApiKey');
    }
  }
  const typeText = typeLabel || sourceDisplayName(snapshot.source, t);

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
        ? t('usage.identityPrefix.project', { value: uniqueId.text })
        : uniqueId.kind === 'account'
          ? t('usage.identityPrefix.account', { value: uniqueId.text })
          : uniqueId.text;

  return (
    <article
      className="quota-account-card"
      data-provider={providerTone(snapshot.provider)}
      data-status={tone}
      // Note: trailing `配额` is deferred to task 14.5 (aria-label /
      // title attribute coverage) — task 14.4's scope is the
      // time-range labels, quota window names, snapshot status
      // badges, source labels, kind labels, and empty-state
      // sentences. The visible catalog already covers all of those.
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
                      {/* The Translation_Key template is `<word> {value}` so
                          substituting an empty value yields exactly the
                          prefix word + trailing space we want as a hint —
                          the actual identifier renders verbatim in the
                          sibling `__unique-id` span next to it. */}
                      {uniqueId.kind === 'project'
                        ? t('usage.identityPrefix.project', { value: '' })
                        : t('usage.identityPrefix.account', { value: '' })}
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
          {snapshotStatusLabel(snapshot, t)}
        </span>
      </header>

      {/* 3. 主内容区 */}
      <div className="quota-account-card__content">
        {snapshot.kind === 'quota' && windows.length > 0 ? (
          <div className="quota-account-card__windows">
            {windows.map(({ window }, i) => (
              <QuotaWindowRow
                key={`${window.name}-${i}`}
                window={window}
                provider={snapshot.provider}
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
              // Currency code (e.g. `CNY`, `USD`) is upstream-sourced
              // and renders verbatim per Requirement 4.5; the
              // 总额 / 赠金 / 充值 segment prefixes route through
              // `quota.credits.*` so the tooltip flips locale with
              // the rest of the UI.
              const creditsSegments = [
                credits.total === null ? null : t('quota.credits.totalPrefix', { value: credits.total }),
                credits.granted === null ? null : t('quota.credits.grantedPrefix', { value: credits.granted }),
                credits.toppedUp === null ? null : t('quota.credits.toppedUpPrefix', { value: credits.toppedUp }),
              ].filter((segment): segment is string => segment !== null);
              const fullName = creditsSegments.length === 0
                ? credits.currency
                : `${credits.currency} ${creditsSegments.join(' / ')}`;
              return (
                <div key={i} className="quota-account-card__credits-row" title={fullName}>
                  <div className="quota-account-card__credits-main">
                    <span className="quota-account-card__credits-value">{displayAmount}</span>
                    <span className="quota-account-card__credits-label">
                      {t('quota.credits.balanceLabel')}
                    </span>
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
            {/* Note: `暂无额度数据` is deferred to task 14.5 (empty-state /
                aria-label coverage) — it is not in the task 14.4 scope
                of "time-range labels, quota window names, snapshot
                status badges, source labels, kind labels, empty-state
                sentences" and the catalog does not yet expose a key
                for it. */}
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
  provider,
}: {
  window: QuotaWindow;
  provider: string;
}): JSX.Element {
  const t = useT();
  const remaining = w.percentLeft;
  const rowClass = quotaWindowToneClass(remaining);
  // Resolve the display label through the locale-aware helper so the
  // visible row tracks Active_Locale; brand strings like `Claude` /
  // `Gemini Pro` (and any window the resolver couldn't map) fall
  // through verbatim per Requirement 4.5.
  const displayName = translateQuotaWindowDisplayName(t, w.name, provider) ?? w.name;

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
