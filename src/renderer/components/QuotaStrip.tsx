// QuotaStrip — compact quota progress bars for the widget shell.
//
// Groups windows by provider, provider name shown once as a header.
// Within each provider, sorted by window duration (5h before weekly).

import { useEffect, useState } from 'react';
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from '../lib/types';
import {
  currencySymbol,
  groupQuotaWindowsByDisplay,
  parseCreditsWindow,
  type ParsedCreditsWindow,
  quotaWindowDisplayName,
  quotaWindowPriority,
} from '../lib/quota-display';
import { ProviderIcon } from './ProviderIcon';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderGroup {
  key: string;
  provider: string;
  accountLabel: string | null;
  windows: QuotaWindow[];
}

interface CompactQuotaEntry {
  key: string;
  provider: string;
  accountLabel: string | null;
  window: QuotaWindow;
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

function providerPriority(provider: string): number {
  switch (provider) {
    case 'codex': return 0;
    case 'claude-code': return 1;
    case 'gemini-cli': return 2;
    case 'antigravity': return 3;
    default: return 10;
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

function entryPriority(entry: CompactQuotaEntry): number {
  if (entry.window.percentLeft === null) return 101;
  return entry.window.percentLeft;
}

export function buildCompactGroups(snapshots: QuotaSnapshot[]): ProviderGroup[] {
  const entries = snapshots.flatMap((snapshot, snapshotIndex): CompactQuotaEntry[] => {
    const key = snapshotKey(snapshot, snapshotIndex);
    // Pre-merge raw windows that share the same display label (e.g. Opus
    // + Sonnet → "Claude 4.6"). Without this the strip would render two
    // identical "Claude 4.6" rows when the cached snapshot still holds
    // multiple raw model buckets.
    const grouped = groupQuotaWindowsByDisplay(snapshot.windows, snapshot.provider);
    return grouped.map(({ window }): CompactQuotaEntry => ({
      key,
      provider: snapshot.provider,
      accountLabel: snapshot.accountLabel,
      window,
    }));
  });

  const orderedEntries = [...entries].sort((a, b) => {
    const urgency = entryPriority(a) - entryPriority(b);
    if (urgency !== 0) return urgency;

    const providerOrder = providerPriority(a.provider) - providerPriority(b.provider);
    if (providerOrder !== 0) return providerOrder;

    const windowOrder =
      quotaWindowPriority(a.window.name, a.provider) -
      quotaWindowPriority(b.window.name, b.provider);
    if (windowOrder !== 0) return windowOrder;

    return a.window.name.localeCompare(b.window.name, 'zh-CN');
  });

  const grouped = new Map<string, ProviderGroup>();

  for (const entry of orderedEntries) {
    const existing = grouped.get(entry.key);
    if (existing) {
      existing.windows.push(entry.window);
    } else {
      grouped.set(entry.key, {
        key: entry.key,
        provider: entry.provider,
        accountLabel: entry.accountLabel,
        windows: [entry.window],
      });
    }
  }

  return [...grouped.values()];
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

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuotaStrip(): JSX.Element | null {
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
}: {
  window: QuotaWindow;
  provider: string;
}): JSX.Element {
  // Credits-style rows (DeepSeek balance, etc.) carry a synthetic name
  // like `credits:CNY 总额 4.25 / 赠金 0.00 / 充值 4.25`. Render those as
  // a balance badge instead of a progress bar — a perpetually-100%
  // green bar would be visually identical to "quota still full" and is
  // misleading for an account that has no resetting allowance.
  const credits = parseCreditsWindow(w.name);
  if (credits !== null) {
    return <CreditsRowItem credits={credits} />;
  }

  const remaining = w.percentLeft ?? 100;
  const fillPercent = Math.max(0, Math.min(remaining, 100));
  const isWarn = w.percentLeft !== null && w.percentLeft < 50;
  const isCritical = w.percentLeft !== null && w.percentLeft < 20;
  const label = quotaWindowDisplayName(w.name, provider) ?? w.name;

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
            {w.percentLeft !== null ? `${Math.round(w.percentLeft)}%` : '?'}
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
// as the focal point (matching the visual weight of the model-name
// label on quota rows), with a muted "余额 · CCY" tag on the right.
// No progress bar — a perpetually-100% green bar would be visually
// indistinguishable from "quota still full" and is misleading for a
// monetary balance with no reset semantics.
function CreditsRowItem({
  credits,
}: {
  credits: ParsedCreditsWindow;
}): JSX.Element {
  const symbol = currencySymbol(credits.currency);
  const amount = credits.total ?? credits.toppedUp ?? credits.granted ?? '—';
  const display = symbol === '' ? `${amount} ${credits.currency}` : `${symbol}${amount}`;
  const numeric = parseFloat(amount);
  const isLow = Number.isFinite(numeric) && numeric < 1;
  const fullName = `${credits.currency} ${[
    credits.total === null ? null : `总额 ${credits.total}`,
    credits.granted === null ? null : `赠金 ${credits.granted}`,
    credits.toppedUp === null ? null : `充值 ${credits.toppedUp}`,
  ].filter(Boolean).join(' / ')}`;

  return (
    <div
      className="quota-strip__row quota-strip__row--credits"
      data-urgency={isLow ? 'critical' : 'ok'}
      title={fullName}
    >
      <div className="quota-strip__row-head">
        <span className="quota-strip__credits-amount">{display}</span>
        <span className="quota-strip__meta">
          <span className="quota-strip__credits-tag">
            余额{credits.currency.length > 0 ? ` · ${credits.currency}` : ''}
          </span>
        </span>
      </div>
    </div>
  );
}
