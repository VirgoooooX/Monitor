// QuotaStrip — compact quota progress bars for the widget shell.
//
// Groups windows by provider, provider name shown once as a header.
// Within each provider, sorted by window duration (5h before weekly).

import { useEffect, useState } from 'react';
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from '../lib/types';
import { ProviderIcon } from './ProviderIcon';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderGroup {
  provider: string;
  windows: QuotaWindow[];
}

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

function windowLabel(name: string): string {
  switch (name) {
    case '5h': return '5h';
    case 'weekly': return '周';
    case 'monthly': return '月';
    case 'daily': return '日';
    default: return name;
  }
}

function windowPriority(name: string): number {
  switch (name) {
    case '5h': return 0;
    case 'daily': return 1;
    case 'weekly': return 2;
    case 'monthly': return 3;
    default: return 4;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuotaStrip(): JSX.Element | null {
  const [groups, setGroups] = useState<ProviderGroup[]>([]);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop || !('getQuotaStatus' in desktop)) return;

    let cancelled = false;

    const fetch = (): void => {
      desktop.getQuotaStatus().then((status: QuotaStatus) => {
        if (cancelled) return;

        // Group by provider, sort windows within each
        const grouped: ProviderGroup[] = status.snapshots.map((snapshot) => ({
          provider: snapshot.provider,
          windows: [...snapshot.windows].sort(
            (a, b) => windowPriority(a.name) - windowPriority(b.name),
          ),
        }));

        setGroups(grouped);
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
        <div key={group.provider} className="quota-strip__group">
          <span className="quota-strip__provider" title={group.provider}>
            <ProviderIcon provider={group.provider} size={20} />
          </span>
          <div className="quota-strip__windows">
            {group.windows.map((w, i) => (
              <QuotaRowItem key={`${w.name}-${i}`} window={w} />
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

function QuotaRowItem({ window: w }: { window: QuotaWindow }): JSX.Element {
  const remaining = w.percentLeft ?? 100;
  const isWarn = w.percentLeft !== null && w.percentLeft < 50;
  const isCritical = w.percentLeft !== null && w.percentLeft < 20;

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
      <span className="quota-strip__window-label">{windowLabel(w.name)}</span>
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
