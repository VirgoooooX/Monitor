// ConnectivityStrip — the four-dot row at the bottom of the compact
// widget summarising the four layers monitored by the priority
// ladder (design.md §Health Status Evaluation, PLAN.md §探测层):
//
//   路由   ← `state.router.ok`
//   Clash  ← `state.openclash.tcpOk && apiOk === true`
//             (note: `'auth_error'` does NOT count as Clash-OK here;
//              the dot mirrors the user's perception of "Clash works",
//              which fails on 401, even though `health.evaluate`
//              folds 401 into `openclash_unreachable`)
//   节点   ← every entry in `state.currentNode.probeResults` is `ok`
//             AND there is at least one entry (an empty list is
//             treated as "unknown" / gray, not "all green by
//             default")
//   外网   ← `state.currentNode.successRate5 >= 0.5`
//             (the rolling 5-attempt rate; `null` means no history
//              yet → unknown / gray)
//
// Each dot has three visual states: green (ok), red (bad), gray
// (unknown). We keep the truth-table here in one place so the CSS
// only has to react to `data-state`.
//
// References:
//   • design.md §Window Strategy
//   • PLAN.md §UI Implementation Guide §紧凑首页

import type { DashboardState } from '../lib/types';

interface ConnectivityStripProps {
  readonly state: DashboardState;
}

type DotState = 'ok' | 'bad' | 'unknown';

interface Dot {
  readonly id: string;
  readonly label: string;
  readonly state: DotState;
}

function routerDot(state: DashboardState): DotState {
  return state.router.ok ? 'ok' : 'bad';
}

function clashDot(state: DashboardState): DotState {
  // `apiOk` can be `true | false | 'auth_error'`. Only the strict
  // `=== true` case lights the dot green; both `false` (TCP/HTTP
  // failure) and `'auth_error'` (401) are user-visible Clash
  // problems.
  const apiTrue = state.openclash.apiOk === true;
  return state.openclash.tcpOk && apiTrue ? 'ok' : 'bad';
}

function nodeDot(state: DashboardState): DotState {
  const results = state.currentNode.probeResults;
  if (results.length === 0) {
    return 'unknown';
  }
  for (const r of results) {
    if (!r.ok) {
      return 'bad';
    }
  }
  return 'ok';
}

function externalDot(state: DashboardState): DotState {
  const rate = state.currentNode.successRate5;
  if (rate === null) {
    return 'unknown';
  }
  return rate >= 0.5 ? 'ok' : 'bad';
}

export function ConnectivityStrip({ state }: ConnectivityStripProps): JSX.Element {
  const dots: readonly Dot[] = [
    { id: 'router', label: '路由', state: routerDot(state) },
    { id: 'clash', label: 'Clash', state: clashDot(state) },
    { id: 'node', label: '节点', state: nodeDot(state) },
    { id: 'external', label: '外网', state: externalDot(state) },
  ];

  return (
    <div className="connectivity-strip" data-testid="connectivity-strip">
      {dots.map((dot) => (
        <div
          key={dot.id}
          className="connectivity-strip__item"
          data-id={dot.id}
          data-state={dot.state}
        >
          <span className="connectivity-strip__dot" aria-hidden="true" />
          <span className="connectivity-strip__label">{dot.label}</span>
        </div>
      ))}
    </div>
  );
}
