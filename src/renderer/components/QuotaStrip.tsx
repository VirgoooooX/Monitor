// QuotaStrip — compact quota progress bars for the widget shell.
//
// Groups windows by provider, provider name shown once as a header.
// Within each provider, sorted by window duration (5h before weekly).

import { useEffect, useState } from 'react';
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from '../lib/types';
import { quotaWindowCompactLabel, quotaWindowPriority } from '../lib/quota-display';
import { ProviderIcon } from './ProviderIcon';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderGroup {
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

const MAX_COMPACT_ROWS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatResetCompact(resetAt: number | null): string {
  if (resetAt === null) return '';
  const diff = resetAt - Date.now();
  if (diff <= 0) return '即将';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) return `${Math.floor(hours / 24)}d`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
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

function buildCompactGroups(snapshots: QuotaSnapshot[]): {
  groups: ProviderGroup[];
  hiddenCount: number;
} {
  const entries = snapshots.flatMap((snapshot, snapshotIndex): CompactQuotaEntry[] => {
    const key = snapshotKey(snapshot, snapshotIndex);
    return snapshot.windows.flatMap((window): CompactQuotaEntry[] => {
      const label = quotaWindowCompactLabel(window.name, snapshot.provider);
      if (label === null) return [];
      return [{
        key,
        provider: snapshot.provider,
        accountLabel: snapshot.accountLabel,
        window,
      }];
    });
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

  const visibleEntries = orderedEntries.slice(0, MAX_COMPACT_ROWS);
  const grouped = new Map<string, ProviderGroup>();

  for (const entry of visibleEntries) {
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

  return {
    groups: [...grouped.values()],
    hiddenCount: Math.max(0, orderedEntries.length - visibleEntries.length),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuotaStrip(): JSX.Element | null {
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop || !('getQuotaStatus' in desktop)) return;

    let cancelled = false;

    const fetch = (): void => {
      desktop.getQuotaStatus().then((status: QuotaStatus) => {
        if (cancelled) return;

        const compact = buildCompactGroups(status.snapshots);
        setGroups(compact.groups);
        setHiddenCount(compact.hiddenCount);
      }).catch(() => {});
    };

    fetch();
    const interval = setInterval(fetch, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (groups.length === 0) return null;

  return (
    <div className="quota-strip" data-testid="quota-strip">
      {groups.map((group) => (
        <div key={group.key} className="quota-strip__group">
          <span
            className="quota-strip__provider"
            title={group.accountLabel ? `${group.provider} · ${group.accountLabel}` : group.provider}
          >
            <ProviderIcon provider={group.provider} size={20} />
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
      {hiddenCount > 0 && (
        <span className="quota-strip__more">另 {hiddenCount} 项</span>
      )}
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
  const remaining = w.percentLeft ?? 100;
  const isWarn = w.percentLeft !== null && w.percentLeft < 50;
  const isCritical = w.percentLeft !== null && w.percentLeft < 20;
  const label = quotaWindowCompactLabel(w.name, provider) ?? w.name;

  let barColorClass = 'quota-strip__fill--ok';
  if (isCritical) barColorClass = 'quota-strip__fill--critical';
  else if (isWarn) barColorClass = 'quota-strip__fill--warn';

  // Trailing decorations are conditional — when the IPC payload
  // omits `resetAt` or the row is not critical, the corresponding
  // span is NOT rendered. Reserving a fixed track for an empty
  // span left ~32 px of dead air to the right of the bar, which
  // pushed the percent column inward and made the row look
  // unbalanced against the sparkline above it.
  const resetText = formatResetCompact(w.resetAt);

  return (
    <div
      className="quota-strip__row"
      data-urgency={isCritical ? 'critical' : isWarn ? 'warn' : 'ok'}
    >
      <span className="quota-strip__window-label" title={w.name}>{label}</span>
      <div className="quota-strip__track">
        <div
          className={`quota-strip__fill ${barColorClass}`}
          style={{ width: `${Math.min(remaining, 100)}%` }}
        />
      </div>
      <span className="quota-strip__percent">
        {w.percentLeft !== null ? `${Math.round(w.percentLeft)}%` : '?'}
      </span>
      {resetText !== '' && (
        <span className="quota-strip__reset">{resetText}</span>
      )}
      {isCritical && <span className="quota-strip__warn-icon">⚠</span>}
    </div>
  );
}
