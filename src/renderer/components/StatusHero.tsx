// StatusHero — compact single-line status indicator.
//
// Redesigned: no background card, just a flat row that matches
// the visual density of the quota strip below.
//
// Layout: [dot] [status label] [latency] [fail count]

import type { DashboardState } from '../lib/types';
import { formatLatency } from '../lib/format';

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

export function StatusHero({ state }: StatusHeroProps): JSX.Element {
  const tone = statusTone(state);
  const failCount = countFailedProbes(state);

  return (
    <div className="status-hero" data-status={tone} data-testid="status-hero">
      <span className="status-hero__dot" aria-hidden="true" />
      <span className="status-hero__label">{state.statusLabel}</span>
      <span className="status-hero__latency">
        {formatLatency(state.currentNode.avgLatencyMs)}
      </span>
      {failCount > 0 && (
        <span className="status-hero__fails">失败{failCount}</span>
      )}
    </div>
  );
}
