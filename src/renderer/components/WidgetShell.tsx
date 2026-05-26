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
// Theming
// -------
// `data-compact-theme` on the root drives the visual preset. The
// underlying business layout (status hero, sparkline, quota strip,
// usage summary) is identical across every preset; only the two
// `aria-hidden` decoration layers (`__fx`, `__chrome`) plus theme
// tokens change. Decoration layers are absolutely positioned and
// `pointer-events: none` so they never intercept the click that
// opens the expanded window.
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

  // Mirror the live status onto the root so theme CSS (notably
  // `signal-pulse`) can recolour its decoration without re-rendering.
  // We also expose the compact theme directly so unit tests can
  // assert the active preset without a roundtrip through the App
  // root's data attributes.
  const dataProps = {
    'data-color-mode': appearance?.colorMode ?? 'dark',
    'data-compact-theme': appearance?.compactTheme ?? 'obsidian-glass',
    'data-status': state.status,
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
      {...dataProps}
    >
      {/* Theme decoration layers. Both are aria-hidden +
          pointer-events: none (in CSS) so they never intercept
          clicks targeting the shell or any interior element. */}
      <div className="widget-shell__fx" aria-hidden="true" />
      <div className="widget-shell__chrome" aria-hidden="true" />

      {/* Foreground content — same business markup as before, just
          wrapped so the theme layers can sit beneath it without
          obscuring text or controls. */}
      <div className="widget-shell__content">
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
    </div>
  );
}
