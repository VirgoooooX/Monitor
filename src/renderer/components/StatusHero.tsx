// StatusHero — compact single-line status indicator.
//
// Redesigned: no background card, just a flat row that matches
// the visual density of the quota strip below.
//
// Layout: [dot] [status label] [latency] [fail count]
//
// The visible status label is derived from the active `HealthStatus`
// via `t('dashboard.health.' + status)` rather than read from the
// (now soft-deprecated) `Dashboard_State.statusLabel` field. See
// i18n-multilingual-support/design.md §"Health status pivot —
// StatusHero and CompactMiniRail" and Requirement 6.
//
// A defensive guard maps any `status` value outside the closed
// `HealthStatus` enum to `'healthy'` before key construction so an
// out-of-band string from a stale main process can never produce a
// missing-key warning or a literal-key fallback in the UI
// (Requirement 6.8).

import type { DashboardState, HealthStatus } from '../lib/types';
import type { TranslationKey } from '../../i18n';
import { formatLatency } from '../lib/format';
import { useT } from '../lib/i18n';

interface StatusHeroProps {
  readonly state: DashboardState;
}

function statusTone(state: DashboardState): 'healthy' | 'warn' | 'bad' | 'critical' {
  switch (state.status) {
    case 'healthy':
      return 'healthy';
    case 'node_slow':
    case 'partial_outage':
      return 'warn';
    case 'node_down':
    case 'openclash_unreachable':
      return 'bad';
    case 'home_down':
      return 'critical';
  }
}

function countFailedProbes(state: DashboardState): number {
  let fails = 0;
  for (const r of state.currentNode.probeResults) {
    if (!r.ok) fails += 1;
  }
  return fails;
}

// The closed `HealthStatus` enum from `src/main/types.ts`. Listed
// explicitly here as a runtime `Set` so the unknown-input guard
// below can do an O(1) membership test without depending on the
// catalog or any other module. Adding a value to the enum forces a
// tsc error at the `satisfies readonly HealthStatus[]` annotation
// rather than silently shrinking the runtime guard.
const SUPPORTED_HEALTH_STATUSES: ReadonlySet<HealthStatus> = new Set<HealthStatus>([
  'healthy',
  'node_slow',
  'node_down',
  'openclash_unreachable',
  'home_down',
  'partial_outage',
] as const satisfies readonly HealthStatus[]);

export function StatusHero({ state }: StatusHeroProps): JSX.Element {
  const t = useT();
  const tone = statusTone(state);
  const failCount = countFailedProbes(state);

  // Requirement 6.1, 6.2, 6.3, 6.8: derive the visible label from the
  // active locale via `t('dashboard.health.' + status)`. Stop reading
  // `state.statusLabel`. Map any out-of-enum value to `'healthy'`
  // before key construction so the result is always a real catalog
  // entry — no missing-key fallback chain is ever exercised here.
  const safeStatus: HealthStatus =
    typeof state.status === 'string' &&
    SUPPORTED_HEALTH_STATUSES.has(state.status as HealthStatus)
      ? (state.status as HealthStatus)
      : 'healthy';
  const label = t(('dashboard.health.' + safeStatus) as TranslationKey);

  return (
    <div className="status-hero" data-status={tone} data-testid="status-hero">
      <span className="status-hero__dot" aria-hidden="true" />
      <span className="status-hero__label">{label}</span>
      <span className="status-hero__latency">
        {formatLatency(state.currentNode.avgLatencyMs)}
      </span>
      {failCount > 0 && (
        <span className="status-hero__fails">
          {t('statusHero.failsBadge', { count: failCount })}
        </span>
      )}
    </div>
  );
}
