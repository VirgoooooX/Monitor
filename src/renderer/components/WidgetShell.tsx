// WidgetShell — the compact-window container.
//
// Layout (unchanged across themes):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Network slot (~72 px)                                         │
//   │   • Left: status hero + node group/name                       │
//   │   • Right: sparkline mini-window                              │
//   ├──────────────────────────────────────────────────────────────┤
//   │ Usage slot (remaining)                                        │
//   │   • QuotaStrip — one row per quota window                     │
//   │   • Token summary — Codex N · Gemini N · OC N                 │
//   └──────────────────────────────────────────────────────────────┘
//
// Theme system
// ------------
// `data-compact-theme` on the root drives the visual preset. Each
// theme is a full design language (material, container, dividers,
// status pill, sparkline framing, quota row). The DOM splits into
// three layers so themes can paint material + ornaments without
// touching the data slots:
//
//   .compact-frame
//     ├── .compact-frame__backdrop    — material (glass, paper, …)
//     ├── .compact-frame__ornaments   — non-layout decoration
//     └── .compact-frame__content     — slots (z-index: 2)
//          ├── .compact-network-slot
//          └── .compact-usage-slot
//
// Both decoration layers are `aria-hidden` and `pointer-events: none`
// so they cannot intercept the click that opens the expanded window.
//
// References:
//   • PLAN.md §UI Implementation Guide §紧凑首页

import type { AppearanceSettings, DashboardState } from '../lib/types';
import { formatTokens } from '../lib/format';
import { StatusHero } from './StatusHero';
import { Sparkline } from './Sparkline';
import { QuotaStrip } from './QuotaStrip';

interface WidgetShellProps {
  readonly state: DashboardState;
  readonly appearance?: AppearanceSettings | undefined;
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

export function WidgetShell({ state, appearance }: WidgetShellProps): JSX.Element {
  const line = nodeLine(state);
  const usage = state.usageToday;

  const handleClick = (): void => {
    const desktop = window.desktop;
    if (desktop) {
      void desktop.openExpanded();
    }
  };

  // Mirror the live status onto the root so theme CSS can recolour
  // its ornaments and status pill without re-rendering.
  const dataProps = {
    'data-color-mode': appearance?.colorMode ?? 'dark',
    'data-compact-theme': appearance?.compactTheme ?? 'mint-monitor',
    'data-status': state.status,
    'data-health-status': state.status,
  };

  return (
    <div
      className="compact-frame"
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
      {...dataProps}
    >
      {/* Theme decoration layers. Both are aria-hidden +
          pointer-events: none (in CSS) so they never intercept
          clicks targeting the shell or any interior element. */}
      <div className="compact-frame__backdrop" aria-hidden="true" />
      <div className="compact-frame__ornaments" aria-hidden="true" />

      <div className="compact-frame__content">
        {/* ── Network slot: status + node copy on the left, sparkline
              mini-window on the right ──────────────────────────── */}
        <section className="compact-network-slot" aria-label="网络状态">
          <div className="compact-network-slot__copy">
            <StatusHero state={state} />

            <div className="compact-node-rail" title={line.tooltip}>
              {line.secondary && (
                <span className="compact-node-rail__group">
                  {line.secondary}
                </span>
              )}
              <span className="compact-node-rail__name">{line.primary}</span>
            </div>
          </div>

          <div className="compact-sparkline-box" aria-hidden="true">
            <Sparkline data={state.currentNode.sparkline} />
          </div>
        </section>

        {/* ── Usage slot: quota rows + token summary ──────────── */}
        <section className="compact-usage-slot" aria-label="AI 用量">
          <QuotaStrip />

          {(usage.codex > 0 || usage.gemini > 0 || usage.opencode > 0) && (
            <div
              className="compact-usage-summary"
              data-testid="widget-shell-usage"
            >
              <span>Codex {formatTokens(usage.codex)}</span>
              <span> · Gemini {formatTokens(usage.gemini)}</span>
              <span> · OC {formatTokens(usage.opencode)}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
