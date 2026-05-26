// StatusHero — the 72-px tall top band of the compact widget.
//
// Layout (left to right):
//   • a colored dot whose hue tracks `state.status` per the priority
//     ladder in PLAN.md §UI 状态文字 / design.md §Property 1:
//       healthy                  → green
//       node_slow                → orange
//       partial_outage           → orange/red mix (we keep it orange,
//                                  the failed-probe count on the right
//                                  already conveys the "partial" half)
//       node_down                → red
//       openclash_unreachable    → red
//       home_down                → red, plus a dimmer background hint
//                                  (driven by `data-status` in CSS)
//   • the user-facing zh-CN `statusLabel` produced by `health.service`
//     so the renderer never has to translate `HealthStatus` itself.
//   • a right-aligned column with the average current-node probe
//     latency on top and a "失败 N" count on the bottom. The fail
//     count is computed locally from `probeResults` rather than
//     plumbed through `DashboardState` because (a) the source of
//     truth is already in the dashboard payload and (b) it keeps the
//     IPC contract minimal.
//
// The drag region is applied via CSS (`-webkit-app-region: drag` on
// `.status-hero`). Anything that needs to remain interactive — there
// is nothing here in v1, but a future "refresh" button would — must
// override with `-webkit-app-region: no-drag`.
//
// References:
//   • design.md §Window Strategy ("72-px status hero")
//   • PLAN.md §UI Implementation Guide §紧凑首页

import type { DashboardState } from '../lib/types';
import { formatLatency } from '../lib/format';

interface StatusHeroProps {
  readonly state: DashboardState;
}

/**
 * Reduce `HealthStatus` to a stable token used by `styles.css`
 * (`.status-hero[data-status="..."]`) and read by the connectivity
 * dot below the hero. Keeping the mapping in a single place avoids
 * scattered `switch` statements and ensures the hero, the dot, and
 * the background hint always agree.
 */
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
      // `home_down` gets a dimmer background to signal "everything's
      // dark" — the actual dimming is done in CSS.
      return 'critical';
  }
}

/**
 * Count the failed entries in `probeResults`. Used for the right-side
 * "失败 N" indicator. Returns 0 when no probes are recorded yet
 * (cold start) so the slot doesn't render `失败 NaN`.
 */
function countFailedProbes(state: DashboardState): number {
  const results = state.currentNode.probeResults;
  if (results.length === 0) {
    return 0;
  }
  let fails = 0;
  for (const r of results) {
    if (!r.ok) {
      fails += 1;
    }
  }
  return fails;
}

export function StatusHero({ state }: StatusHeroProps): JSX.Element {
  const tone = statusTone(state);
  const failCount = countFailedProbes(state);

  return (
    <div className="status-hero" data-status={tone} data-testid="status-hero">
      <div className="status-hero__left">
        <span className="status-hero__dot" aria-hidden="true" />
        <span className="status-hero__label" title={state.statusLabel}>
          {state.statusLabel}
        </span>
      </div>
      <div className="status-hero__right">
        <span className="status-hero__latency">
          {formatLatency(state.currentNode.avgLatencyMs)}
        </span>
        <span className="status-hero__fails">失败 {failCount}</span>
      </div>
    </div>
  );
}
