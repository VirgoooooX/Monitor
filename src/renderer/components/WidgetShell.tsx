// WidgetShell — the compact-window container (redesigned).
//
// New layout (50/50 split — network + AI quota):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  Network section (~50%)                                       │
//   │   • Left: status + latency, then group · node name            │
//   │   • Right: sparkline spanning both network rows               │
//   ├──────────────────────────────────────────────────────────────┤
//   │  AI section (~50%)                                            │
//   │   • QuotaStrip: one row per quota window (sorted by urgency) │
//   │   • Token summary: Codex N · Gemini N · OC N                 │
//   └──────────────────────────────────────────────────────────────┘
//
// The whole shell is clickable → opens expanded window.
//
// References:
//   • PLAN.md §UI Implementation Guide §紧凑首页

import type { DashboardState } from '../lib/types';
import { formatTokens } from '../lib/format';
import { StatusHero } from './StatusHero';
import { Sparkline } from './Sparkline';
import { QuotaStrip } from './QuotaStrip';

interface WidgetShellProps {
  readonly state: DashboardState;
}

function nodeLine(state: DashboardState): {
  primary: string;
  secondary: string | null;
  tooltip: string;
} {
  const group = state.currentNode.group;
  const node = state.currentNode.node;
  if (group && node) {
    return { primary: node, secondary: group, tooltip: `${group} · ${node}` };
  }
  if (node) return { primary: node, secondary: null, tooltip: node };
  if (group) {
    return {
      primary: '未选择真实节点',
      secondary: group,
      tooltip: `${group} 当前选择为 DIRECT/GLOBAL/REJECT`,
    };
  }
  return { primary: '等待节点数据', secondary: null, tooltip: '当前节点暂无数据' };
}

export function WidgetShell({ state }: WidgetShellProps): JSX.Element {
  const line = nodeLine(state);
  const usage = state.usageToday;

  const handleClick = (): void => {
    const desktop = window.desktop;
    if (desktop) {
      void desktop.openExpanded();
    }
  };

  return (
    <div
      className="widget-shell"
      data-testid="widget-shell"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {/* ── Network section: two-line copy + two-row sparkline ── */}
      <div className="widget-shell__network">
        <div className="widget-shell__network-copy">
          <StatusHero state={state} />

          <span className="widget-shell__node" title={line.tooltip}>
            {line.secondary && (
              <span className="widget-shell__node-group">{line.secondary}</span>
            )}
            <span className="widget-shell__node-name">{line.primary}</span>
          </span>
        </div>

        <div className="widget-shell__sparkline" aria-hidden="true">
          <Sparkline data={state.currentNode.sparkline} />
        </div>
      </div>

      {/* ── AI section ── */}
      <div className="widget-shell__ai">
        <QuotaStrip />

        {(usage.codex > 0 || usage.gemini > 0 || usage.opencode > 0) && (
          <div className="widget-shell__usage" data-testid="widget-shell-usage">
            <span>Codex {formatTokens(usage.codex)}</span>
            <span> · Gemini {formatTokens(usage.gemini)}</span>
            <span> · OC {formatTokens(usage.opencode)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
