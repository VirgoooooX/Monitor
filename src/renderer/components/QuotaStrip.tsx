// QuotaStrip — compact quota progress bars for the widget shell.
//
// Groups windows by provider, provider name shown once as a header.
// Order is intentionally fixed (no auto-sort by urgency):
//   - Groups: codex → claude-code → gemini-cli → antigravity →
//             deepseek → xiaomi → gemini-api → openai-compatible.
//   - Within a group: 5h → 日 → 周 → 月 (Codex/Claude/Anthropic),
//                     Claude → Gemini (Antigravity),
//                     Gemini Pro → Gemini Flash (Gemini CLI).
// See `quotaWindowPriority` in lib/quota-display.ts for the per-window order.

import { useEffect, useState } from 'react';
import type {
  DailyUsagePoint,
  QuotaSnapshot,
  QuotaStatus,
  QuotaWindow,
} from '../lib/types';
import {
  currencySymbol,
  groupQuotaWindowsByDisplay,
  parseCreditsWindow,
  type ParsedCreditsWindow,
  quotaWindowPriority,
  translateQuotaWindowDisplayName,
} from '../lib/quota-display';
import { useT } from '../lib/i18n';
import { formatTokens } from '../lib/format';
import type { Translator } from '../../i18n';
import { ProviderIcon } from './ProviderIcon';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderGroup {
  key: string;
  provider: string;
  accountLabel: string | null;
  windows: QuotaWindow[];
  /**
   * Per-day usage history surfaced by the snapshot, when the
   * adapter exposes it (currently only Xiaomi MiMo). Forwarded
   * verbatim to the credits-row sparkline.
   */
  dailyUsage?: ReadonlyArray<DailyUsagePoint> | null;
}

export const PREVIEW_QUOTA_STATUS: QuotaStatus = {
  snapshots: [
    {
      provider: 'codex',
      capturedAt: Date.now(),
      source: 'imported_auth',
      windows: [
        {
          name: '5h',
          percentLeft: 85,
          resetAt: new Date(2026, 4, 27, 12, 39).getTime(),
          windowSeconds: 18_000,
        },
      ],
      providerAuthId: 'codex-preview',
      accountLabel: 'Codex',
      accountId: null,
      projectId: null,
      kind: 'quota',
      status: 'ok',
      rawPlanLabel: 'Pro',
      modelGroup: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    {
      provider: 'antigravity',
      capturedAt: Date.now(),
      source: 'imported_auth',
      windows: [
        {
          name: 'MODEL_CLAUDE_OPUS_4_6_THINKING',
          percentLeft: 100,
          resetAt: new Date(2026, 4, 27, 6, 1).getTime(),
          windowSeconds: null,
        },
        {
          name: 'MODEL_GOOGLE_GEMINI_3_1_PRO',
          percentLeft: 80,
          resetAt: new Date(2026, 4, 27, 6, 1).getTime(),
          windowSeconds: null,
        },
      ],
      providerAuthId: 'antigravity-preview',
      accountLabel: 'Antigravity',
      accountId: null,
      projectId: null,
      kind: 'quota',
      status: 'ok',
      rawPlanLabel: 'Pro',
      modelGroup: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    // Preview snapshot for the DeepSeek credits row — exercises the
    // CreditsRowItem layout with a plausible 30-day spend curve.
    {
      provider: 'deepseek',
      capturedAt: Date.now(),
      source: 'imported_auth',
      windows: [
        {
          name: 'credits:CNY 总额 4.25 / 赠金 0.00 / 充值 4.25',
          percentLeft: null,
          resetAt: null,
          windowSeconds: null,
        },
      ],
      providerAuthId: 'deepseek-preview',
      accountLabel: 'DeepSeek',
      accountId: null,
      projectId: null,
      kind: 'credits',
      status: 'ok',
      rawPlanLabel: null,
      modelGroup: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      dailyUsage: [
        { date: '2026-05-01', cost: '0.12', totalTokens: 1200 },
        { date: '2026-05-02', cost: '0.30', totalTokens: 3000 },
        { date: '2026-05-03', cost: '0.04', totalTokens: 400 },
        { date: '2026-05-04', cost: '0.55', totalTokens: 5500 },
        { date: '2026-05-05', cost: '0.18', totalTokens: 1800 },
        { date: '2026-05-06', cost: '0.00', totalTokens: 0 },
        { date: '2026-05-07', cost: '0.42', totalTokens: 4200 },
        { date: '2026-05-08', cost: '0.61', totalTokens: 6100 },
        { date: '2026-05-09', cost: '0.05', totalTokens: 500 },
        { date: '2026-05-10', cost: '0.27', totalTokens: 2700 },
        { date: '2026-05-11', cost: '0.85', totalTokens: 8500 },
        { date: '2026-05-12', cost: '0.34', totalTokens: 3400 },
        { date: '2026-05-13', cost: '0.10', totalTokens: 1000 },
        { date: '2026-05-14', cost: '0.21', totalTokens: 2100 },
        { date: '2026-05-15', cost: '0.49', totalTokens: 4900 },
        { date: '2026-05-16', cost: '0.00', totalTokens: 0 },
        { date: '2026-05-17', cost: '0.18', totalTokens: 1800 },
        { date: '2026-05-18', cost: '0.66', totalTokens: 6600 },
        { date: '2026-05-19', cost: '0.13', totalTokens: 1300 },
        { date: '2026-05-20', cost: '0.40', totalTokens: 4000 },
        { date: '2026-05-21', cost: '0.92', totalTokens: 9200 },
        { date: '2026-05-22', cost: '0.05', totalTokens: 500 },
        { date: '2026-05-23', cost: '0.31', totalTokens: 3100 },
        { date: '2026-05-24', cost: '0.07', totalTokens: 700 },
        { date: '2026-05-25', cost: '0.20', totalTokens: 2000 },
        { date: '2026-05-26', cost: '0.58', totalTokens: 5800 },
        { date: '2026-05-27', cost: '0.16', totalTokens: 1600 },
      ],
    },
    // Preview snapshot for the Xiaomi credits row.
    {
      provider: 'xiaomi',
      capturedAt: Date.now(),
      source: 'imported_auth',
      windows: [
        {
          name: 'credits:CNY 总额 24.63 / 现金 24.63 / 赠金 0.00',
          percentLeft: null,
          resetAt: null,
          windowSeconds: null,
        },
      ],
      providerAuthId: 'xiaomi-preview',
      accountLabel: 'Xiaomi MiMo',
      accountId: null,
      projectId: null,
      kind: 'credits',
      status: 'ok',
      rawPlanLabel: null,
      modelGroup: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      dailyUsage: [
        { date: '2026-05-08', cost: '0.02', totalTokens: 200 },
        { date: '2026-05-09', cost: '0.15', totalTokens: 1500 },
        { date: '2026-05-10', cost: '0.08', totalTokens: 800 },
        { date: '2026-05-11', cost: '0.22', totalTokens: 2200 },
        { date: '2026-05-12', cost: '0.45', totalTokens: 4500 },
        { date: '2026-05-13', cost: '0.00', totalTokens: 0 },
        { date: '2026-05-14', cost: '0.30', totalTokens: 3000 },
        { date: '2026-05-15', cost: '0.50', totalTokens: 5000 },
        { date: '2026-05-16', cost: '0.10', totalTokens: 1000 },
        { date: '2026-05-17', cost: '0.04', totalTokens: 400 },
        { date: '2026-05-18', cost: '0.18', totalTokens: 1800 },
        { date: '2026-05-19', cost: '0.65', totalTokens: 6500 },
        { date: '2026-05-20', cost: '0.25', totalTokens: 2500 },
        { date: '2026-05-21', cost: '0.07', totalTokens: 700 },
        { date: '2026-05-22', cost: '0.33', totalTokens: 3300 },
        { date: '2026-05-23', cost: '0.12', totalTokens: 1200 },
        { date: '2026-05-24', cost: '0.40', totalTokens: 4000 },
        { date: '2026-05-25', cost: '0.06', totalTokens: 600 },
        { date: '2026-05-26', cost: '0.28', totalTokens: 2800 },
        { date: '2026-05-27', cost: '0.14', totalTokens: 1400 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatResetCompact(resetAt: number | null): string {
  if (resetAt === null) return '';
  const resetDate = new Date(resetAt);
  if (Number.isNaN(resetDate.getTime())) return '';

  const month = String(resetDate.getMonth() + 1).padStart(2, '0');
  const day = String(resetDate.getDate()).padStart(2, '0');
  const hour = String(resetDate.getHours()).padStart(2, '0');
  const minute = String(resetDate.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

function isLocalBrowserPreview(): boolean {
  return (
    !window.desktop &&
    (window.location.hostname === '127.0.0.1' ||
      window.location.hostname === 'localhost')
  );
}

// Fixed display order for the quota strip. Lower number = higher up.
// Order is intentionally hard-coded — the strip does not auto-sort by
// urgency. Codex sits at the top so the 5h / weekly windows stay in
// the user's primary line of sight; API-credit adapters (DeepSeek,
// Xiaomi MiMo) sit at the bottom; health-only adapters last.
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
    case 'gemini-api': return 8;
    case 'openai-compatible': return 9;
    default: return 100;
  }
}

function snapshotKey(snapshot: QuotaSnapshot, index: number): string {
  return (
    snapshot.providerAuthId ??
    snapshot.accountId ??
    snapshot.projectId ??
    `${snapshot.provider}-${index}`
  );
}

export function buildCompactGroups(snapshots: QuotaSnapshot[]): ProviderGroup[] {
  const grouped = new Map<string, ProviderGroup>();
  const insertionIndex = new Map<string, number>();

  snapshots.forEach((snapshot, snapshotIndex) => {
    // Pre-merge raw windows that share the same display label (e.g.
    // Opus + Sonnet → "Claude"). Without this the strip would render
    // two identical "Claude" rows when the cached snapshot still
    // holds multiple raw model buckets.
    const groupedWindows = groupQuotaWindowsByDisplay(
      snapshot.windows,
      snapshot.provider,
    );
    if (groupedWindows.length === 0) return;

    const key = snapshotKey(snapshot, snapshotIndex);
    const newWindows = groupedWindows.map((g) => g.window);

    const existing = grouped.get(key);
    if (existing) {
      existing.windows.push(...newWindows);
      // Keep the first non-null dailyUsage we see — every entry from
      // the same snapshot carries the same array reference, so the
      // assignment is idempotent in practice.
      if (
        existing.dailyUsage === undefined &&
        snapshot.dailyUsage !== undefined &&
        snapshot.dailyUsage !== null
      ) {
        existing.dailyUsage = snapshot.dailyUsage;
      }
    } else {
      insertionIndex.set(key, snapshotIndex);
      grouped.set(key, {
        key,
        provider: snapshot.provider,
        accountLabel: snapshot.accountLabel,
        windows: newWindows,
        ...(snapshot.dailyUsage !== undefined && snapshot.dailyUsage !== null
          ? { dailyUsage: snapshot.dailyUsage }
          : {}),
      });
    }
  });

  // Sort each group's windows by the fixed per-provider window priority.
  // Tie-breaker is the raw name so the order is deterministic across
  // re-renders even when two windows share a display label after grouping.
  for (const group of grouped.values()) {
    group.windows.sort((a, b) => {
      const wp =
        quotaWindowPriority(a.name, group.provider) -
        quotaWindowPriority(b.name, group.provider);
      if (wp !== 0) return wp;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  // Sort groups by the fixed provider priority. Within the same
  // provider class (e.g. two `openai-compatible` accounts) fall back
  // to the original snapshot order so the strip stays stable.
  return [...grouped.values()].sort((a, b) => {
    const pp = providerPriority(a.provider) - providerPriority(b.provider);
    if (pp !== 0) return pp;
    return (insertionIndex.get(a.key) ?? 0) - (insertionIndex.get(b.key) ?? 0);
  });
}

export function useQuotaStatus(): QuotaStatus | null {
  const [status, setStatus] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop || !('getQuotaStatus' in desktop)) {
      if (isLocalBrowserPreview()) {
        setStatus(PREVIEW_QUOTA_STATUS);
      }
      return;
    }

    let cancelled = false;

    const fetch = (): void => {
      desktop.getQuotaStatus().then((next: QuotaStatus) => {
        if (!cancelled) {
          setStatus(next);
        }
      }).catch(() => {});
    };

    fetch();
    const interval = setInterval(fetch, 30_000);

    // Subscribe to provider-auth push events. Every successful
    // mutation in main fans out a `provider-auth.updated` event
    // carrying the fresh QuotaStatus, so the floating widget
    // reflects add/delete/refresh within ~one IPC round-trip
    // instead of waiting on the 30s polling tick.
    //
    // The `desktop.on` API only exists in production builds —
    // local browser preview does not provide it; guard with the
    // `'on' in desktop` check.
    let unsubscribe: (() => void) | undefined;
    if ('on' in desktop && typeof desktop.on === 'function') {
      try {
        unsubscribe = desktop.on('provider-auth.updated', (payload) => {
          if (!cancelled && payload?.quotaStatus !== undefined) {
            setStatus(payload.quotaStatus);
          }
        });
      } catch {
        // Channel rejection (preload allowlist drift) — fall back
        // to the polling tick.
      }
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (unsubscribe) unsubscribe();
    };
  }, []);

  return status;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuotaStrip(): JSX.Element | null {
  const t = useT();
  const quotaStatus = useQuotaStatus();
  const groups = quotaStatus ? buildCompactGroups(quotaStatus.snapshots) : [];

  if (groups.length === 0) return null;

  return (
    <div className="quota-strip" data-testid="quota-strip">
      {groups.map((group) => (
        <div key={group.key} className="quota-strip__group">
          <span
            className="quota-strip__provider"
            title={group.accountLabel ? `${group.provider} · ${group.accountLabel}` : group.provider}
          >
            <ProviderIcon provider={group.provider} size={24} />
          </span>
          <div className="quota-strip__windows">
            {group.windows.map((w, i) => (
              <QuotaRowItem
                key={`${w.name}-${i}`}
                window={w}
                provider={group.provider}
                dailyUsage={group.dailyUsage ?? null}
                t={t}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single quota row (no provider name — shown by parent group)
// ---------------------------------------------------------------------------

function QuotaRowItem({
  window: w,
  provider,
  dailyUsage,
  t,
}: {
  window: QuotaWindow;
  provider: string;
  dailyUsage: ReadonlyArray<DailyUsagePoint> | null;
  t: Translator;
}): JSX.Element {
  // Credits-style rows (DeepSeek balance, etc.) carry a synthetic name
  // like `credits:CNY 总额 4.25 / 赠金 0.00 / 充值 4.25`. Render those as
  // a balance badge instead of a progress bar — a perpetually-100%
  // green bar would be visually identical to "quota still full" and is
  // misleading for an account that has no resetting allowance.
  const credits = parseCreditsWindow(w.name);
  if (credits !== null) {
    return <CreditsRowItem credits={credits} dailyUsage={dailyUsage} t={t} />;
  }

  // Treat unknown quota (`percentLeft === null`) as 0 — both the text,
  // the bar fill, and the urgency tone. The previous fallback of 100
  // painted a full green bar next to a `?`, which read visually as
  // "quota still full" and was misleading. Showing 0% as critical
  // (red) keeps the tone consistent with a real 1% reading.
  const remaining = w.percentLeft ?? 0;
  const fillPercent = Math.max(0, Math.min(remaining, 100));
  const isWarn = remaining < 50;
  const isCritical = remaining < 20;
  const label = translateQuotaWindowDisplayName(t, w.name, provider) ?? w.name;

  let barColorClass = 'quota-strip__fill--ok';
  if (isCritical) barColorClass = 'quota-strip__fill--critical';
  else if (isWarn) barColorClass = 'quota-strip__fill--warn';

  const resetText = formatResetCompact(w.resetAt);

  return (
    <div
      className="quota-strip__row"
      data-urgency={isCritical ? 'critical' : isWarn ? 'warn' : 'ok'}
    >
      <div className="quota-strip__row-head">
        <span className="quota-strip__window-label" title={w.name}>{label}</span>
        <span className="quota-strip__meta">
          <span className="quota-strip__percent">
            {`${Math.round(w.percentLeft ?? 0)}%`}
          </span>
          {resetText !== '' && (
            <span className="quota-strip__reset">{resetText}</span>
          )}
          {isCritical && <span className="quota-strip__warn-icon">⚠</span>}
        </span>
      </div>
      <div className="quota-strip__track">
        <div
          className={`quota-strip__fill ${barColorClass}`}
          style={{ width: `${fillPercent}%` }}
        />
      </div>
    </div>
  );
}

// Credits balances render as a single-line badge: amount on the left
// (fixed-width column so all rows align), a daily-usage sparkline in
// the middle (occupies a constant slot whether or not data is
// available, so all providers start the bar chart at the same x), and
// a muted "余额 · CCY" tag on the right.
//
// No progress bar — a perpetually-100% green bar would be visually
// indistinguishable from "quota still full" and is misleading for a
// monetary balance with no reset semantics.
function CreditsRowItem({
  credits,
  dailyUsage,
  t,
}: {
  credits: ParsedCreditsWindow;
  dailyUsage: ReadonlyArray<DailyUsagePoint> | null;
  t: Translator;
}): JSX.Element {
  const symbol = currencySymbol(credits.currency);
  const amount = credits.total ?? credits.toppedUp ?? credits.granted ?? '—';
  const display = symbol === '' ? `${amount} ${credits.currency}` : `${symbol}${amount}`;
  const numeric = parseFloat(amount);
  const isLow = Number.isFinite(numeric) && numeric < 1;
  // Composite hover string — currency code is upstream-sourced and
  // renders verbatim per Requirement 4.5; the `总额` / `赠金` /
  // `充值` segment prefixes route through `quota.credits.*` so the
  // tooltip flips locale with the rest of the UI.
  const segments = [
    credits.total === null ? null : t('quota.credits.totalPrefix', { value: credits.total }),
    credits.granted === null ? null : t('quota.credits.grantedPrefix', { value: credits.granted }),
    credits.toppedUp === null ? null : t('quota.credits.toppedUpPrefix', { value: credits.toppedUp }),
  ].filter((segment): segment is string => segment !== null);
  const fullName = segments.length === 0
    ? credits.currency
    : `${credits.currency} ${segments.join(' / ')}`;

  return (
    <div
      className="quota-strip__row quota-strip__row--credits"
      data-urgency={isLow ? 'critical' : 'ok'}
      title={fullName}
    >
      <div className="quota-strip__row-head">
        <span className="quota-strip__credits-amount">{display}</span>
        <UsageSparkline
          dailyUsage={dailyUsage}
          currencySymbol={symbol}
          currencyCode={credits.currency}
        />
        <span className="quota-strip__meta">
          <span className="quota-strip__credits-tag">
            {t('quota.credits.balanceLabel')}
            {credits.currency.length > 0 ? ` · ${credits.currency}` : ''}
          </span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsageSparkline — fixed-width inline bar chart of recent daily spend.
// ---------------------------------------------------------------------------
//
// The slot has constant outer dimensions so every credits row in the
// strip starts the chart at the same horizontal position. When the
// adapter does not surface usage data the slot still occupies the
// space (filled with a faint grid / placeholder) — this keeps the
// "余额 · CCY" tag aligned across providers.
//
// Visual model:
//   - 14-day rolling window. Older days fall off; missing days
//     between data points get a 1px grey tick so the day count is
//     visually preserved (no collapsing zeros).
//   - Bars within the most recent 7 days render at full opacity;
//     bars older than 7 days fade out smoothly to ~35% so the eye
//     is drawn to recent activity.
//   - The last bar (today, or the latest known day) is rendered at
//     a slightly brighter shade so the "current" position is easy
//     to find.
export function UsageSparkline({
  dailyUsage,
  currencySymbol: symbol,
  currencyCode,
}: {
  dailyUsage: ReadonlyArray<DailyUsagePoint> | null;
  currencySymbol: string;
  currencyCode: string;
}): JSX.Element {
  const t = useT();
  const MAX_BARS = 14;
  const RECENT_BARS = 7; // last N days at full opacity
  // Outer SVG layout — kept in sync with the `.quota-strip__sparkline`
  // CSS so the bar widths land on near-integer pixel values.
  const VIEW_W = 90;
  const VIEW_H = 18;
  const GAP = 1;

  // Trim to the most recent MAX_BARS entries, then back-fill any
  // missing calendar days with zero-value placeholders so the
  // sparkline shows a stable "one tick per day" rhythm even when
  // the adapter response skips days with no usage.
  const filled = fillMissingDays(dailyUsage ?? [], MAX_BARS);

  const values = filled.map((p) => p.totalTokens);
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const barWidth = (VIEW_W - GAP * (MAX_BARS - 1)) / MAX_BARS;
  const hasData = values.some((v) => Number.isFinite(v) && v > 0);

  return (
    <span
      className="quota-strip__sparkline"
      data-has-data={hasData ? 'true' : 'false'}
      aria-label={t('quota.credits.sparklineAria')}
    >
      <svg
        width={VIEW_W}
        height={VIEW_H}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
      >
        {/* Baseline so the slot is visible even with no data. */}
        <line
          x1="0"
          x2={VIEW_W}
          y1={VIEW_H - 0.5}
          y2={VIEW_H - 0.5}
          className="quota-strip__sparkline-base"
        />
        {filled.map((point, idx) => {
          const value = Number.isFinite(values[idx]) ? values[idx]! : 0;
          const x = idx * (barWidth + GAP);
          const cost = Number(point.cost);
          const costSuffix = Number.isFinite(cost) && cost > 0
            ? ` · ${symbol}${point.cost}${currencyCode ? ` ${currencyCode}` : ''}`
            : '';
          const tip = `${point.date} · ${formatTokens(point.totalTokens)} tok${costSuffix}`;

          // Recency fade: most recent RECENT_BARS days at 100%,
          // older days drop off linearly toward 35%. Total span
          // is `MAX_BARS - RECENT_BARS` slots.
          const distanceFromLast = filled.length - 1 - idx;
          const isToday = idx === filled.length - 1;
          const isRecent = distanceFromLast < RECENT_BARS;
          const fadeT = isRecent
            ? 0
            : Math.min(
                1,
                (distanceFromLast - (RECENT_BARS - 1)) /
                  Math.max(1, MAX_BARS - RECENT_BARS),
              );
          const opacity = 1 - fadeT * 0.65;

          // Zero-day placeholder: 1px grey tick so the day rhythm
          // is preserved without a misleading colored bar.
          if (max <= 0 || value <= 0) {
            return (
              <rect
                key={point.date}
                x={x}
                y={VIEW_H - 1}
                width={barWidth}
                height={1}
                className="quota-strip__sparkline-zero"
              >
                <title>
                  {`${point.date} · 0 tok`}
                </title>
              </rect>
            );
          }

          const h = Math.max(1, (value / max) * (VIEW_H - 1));
          const y = VIEW_H - h;
          return (
            <rect
              key={point.date}
              x={x}
              y={y}
              width={barWidth}
              height={h}
              opacity={opacity}
              className={
                isToday
                  ? 'quota-strip__sparkline-bar quota-strip__sparkline-bar--today'
                  : 'quota-strip__sparkline-bar'
              }
            >
              <title>{tip}</title>
            </rect>
          );
        })}
      </svg>
    </span>
  );
}

/**
 * Trim `points` to the most-recent `maxBars` calendar days and
 * back-fill any gaps with zero-cost placeholders so the bar chart
 * always renders exactly `maxBars` slots in chronological order.
 *
 * Anchors the right edge to the last available date (or "today" if
 * `points` is empty). When points span fewer days than the window,
 * the earlier slots are zero-filled — i.e. a brand-new account on
 * day 3 will render 11 zero ticks followed by 3 real bars.
 */
function fillMissingDays(
  points: ReadonlyArray<DailyUsagePoint>,
  maxBars: number,
): DailyUsagePoint[] {
  if (maxBars <= 0) return [];
  const byDate = new Map<string, DailyUsagePoint>();
  for (const p of points) byDate.set(p.date, p);

  // Anchor: last date in the input, falling back to today (UTC).
  const anchorIso =
    points.length > 0
      ? points[points.length - 1]!.date
      : isoDateOnly(new Date());

  const out: DailyUsagePoint[] = [];
  for (let i = maxBars - 1; i >= 0; i--) {
    const iso = shiftDateIso(anchorIso, -i);
    const existing = byDate.get(iso);
    out.push(
      existing ?? {
        date: iso,
        cost: '0',
        totalTokens: 0,
      },
    );
  }
  return out;
}

function isoDateOnly(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shiftDateIso(iso: string, deltaDays: number): string {
  // Parse `YYYY-MM-DD` as a UTC instant so DST cannot shift the
  // resulting date by ±1 day.
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  const t = Date.UTC(y!, m! - 1, d!) + deltaDays * 86_400_000;
  return isoDateOnly(new Date(t));
}
