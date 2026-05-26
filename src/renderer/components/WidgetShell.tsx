// WidgetShell — the compact-window container.
//
// Layout (top to bottom, fits within the 360×240 frameless transparent
// window from `windows.ts#createCompactWindow`):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  StatusHero (≈72 px)                                          │
//   │   • zh-CN status label + colored dot                         │
//   │   • avg latency + 失败 N                                      │
//   ├──────────────────────────────────────────────────────────────┤
//   │  primary group · current node       (single line, truncated) │
//   ├──────────────────────────────────────────────────────────────┤
//   │  ConnectivityStrip: 路由 / Clash / 节点 / 外网                │
//   ├──────────────────────────────────────────────────────────────┤
//   │  今日 Codex N · Gemini N · OpenCode N                         │
//   └──────────────────────────────────────────────────────────────┘
//
// The whole shell is clickable and is meant to request the expanded
// window. The IPC verb that opens the expanded window is wired up in
// task 5.8; until then the click handler logs a TODO. We deliberately
// do NOT call `refreshNow()` as a stand-in: that would surprise users
// who click the widget expecting a window to open.
//
// References:
//   • design.md §Window Strategy
//   • PLAN.md §UI Implementation Guide §紧凑首页

import type { DashboardState } from '../lib/types';
import { formatTokens } from '../lib/format';
import { StatusHero } from './StatusHero';
import { ConnectivityStrip } from './ConnectivityStrip';
import { Sparkline } from './Sparkline';

interface WidgetShellProps {
  readonly state: DashboardState;
}

/**
 * Build the "primary group · current node" middle line. When either
 * field is missing (cold boot, OpenClash unreachable) we fall back to
 * an em-dash so the slot keeps its height and the layout doesn't
 * jump.
 */
function nodeLine(state: DashboardState): { text: string; tooltip: string } {
  const group = state.currentNode.group;
  const node = state.currentNode.node;
  if (group && node) {
    const text = `${group} · ${node}`;
    return { text, tooltip: text };
  }
  if (node) {
    return { text: node, tooltip: node };
  }
  if (group) {
    return { text: group, tooltip: group };
  }
  return { text: '— · —', tooltip: '当前节点暂无数据' };
}

export function WidgetShell({ state }: WidgetShellProps): JSX.Element {
  const line = nodeLine(state);
  const usage = state.usageToday;

  // Clicking anywhere on the widget should open the expanded window.
  // The main-side IPC verb is added in task 5.8 (Node table view in
  // expanded window); until then we surface a TODO marker on the
  // console so manual QA can confirm the click is reaching here.
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
      <StatusHero state={state} />

      <div className="widget-shell__node-row">
        <div className="widget-shell__node" title={line.tooltip}>
          {line.text}
        </div>
        <Sparkline data={state.currentNode.sparkline} />
      </div>

      <ConnectivityStrip state={state} />

      <div className="widget-shell__usage" data-testid="widget-shell-usage">
        <span className="widget-shell__usage-prefix">今日</span>
        <span> Codex {formatTokens(usage.codex)}</span>
        <span> · Gemini {formatTokens(usage.gemini)}</span>
        <span> · OpenCode {formatTokens(usage.opencode)}</span>
      </div>
    </div>
  );
}
