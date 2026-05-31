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
// so they never intercept the click that opens the expanded window.
//
// References:
//   • PLAN.md §UI Implementation Guide §紧凑首页
//

import type { AppearanceSettings, DashboardState } from '../lib/types';
import type { Translator } from '../../i18n';
import { formatTokens } from '../lib/format';
import { useT } from '../lib/i18n';
import { StatusHero } from './StatusHero';
import { Sparkline } from './Sparkline';
import { QuotaStrip } from './QuotaStrip';
import { CompactMiniRail } from './CompactMiniRail';

interface WidgetShellProps {
  readonly state: DashboardState;
  readonly appearance?: AppearanceSettings | undefined;
  readonly displayMode?: 'expanded' | 'mini';
  readonly onDisplayModeChange?: (mode: 'expanded' | 'mini') => void;
}

function nodeLine(
  t: Translator,
  state: DashboardState,
): {
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
      primary: t('compact.unselectedReal.primary'),
      secondary: group,
      tooltip: t('compact.unselectedReal.tooltip', { group }),
    };
  }
  return {
    primary: t('compact.waitingNode.primary'),
    secondary: null,
    tooltip: t('compact.waitingNode.tooltip'),
  };
}

export function WidgetShell({
  state,
  appearance,
  displayMode = 'expanded',
  onDisplayModeChange,
}: WidgetShellProps): JSX.Element {
  const t = useT();
  const line = nodeLine(t, state);
  const usage = state.usageToday;
  const isMini = displayMode === 'mini';

  const handleClick = (): void => {
    if (isMini) {
      onDisplayModeChange?.('expanded');
      return;
    }
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
    'data-display-mode': displayMode,
  };

  const renderExpandedContent = (showMiniToggle: boolean): JSX.Element => (
    <>
      {showMiniToggle && (
        <button
          type="button"
          className="compact-mini-toggle-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDisplayModeChange?.('mini');
          }}
          title={t('compact.shrink.title')}
          aria-label={t('compact.shrink.aria')}
        >
          {/* Bare corner-mark — two perpendicular hairlines meeting
              at the top-right. No container, no fill, no border. The
              strokes pull inward on hover, telegraphing the tuck-away
              that the click performs. */}
          {/* Curved corner-mark — a quarter-arc that nests inside
              the widget's own rounded corner. Curvature direction
              matches the frame radius so the mark reads as a
              concentric inner echo of the corner itself, not a
              foreign UI overlay. On hover it pulls inward slightly,
              telegraphing the tuck-away the click performs. */}
          <svg
            className="compact-mini-toggle-glyph"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            {/* Move to (3, 1) → arc of radius 11 to (15, 13).
                 Same curvature as a 12 px corner, mirrors the
                 widget's rounded shell. */}
            <path
              className="compact-mini-toggle-arc"
              d="M 3 1.6 A 11 11 0 0 1 14.4 13"
            />
          </svg>
        </button>
      )}

      <div className="compact-frame__content">
        {/* ── Network slot: status + node copy on the left, sparkline
              mini-window on the right ──────────────────────────── */}
        <section className="compact-network-slot" aria-label={t('compact.network.aria')}>
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
        <section className="compact-usage-slot" aria-label={t('compact.usage.aria')}>
          <div className="compact-usage-slot__scroll-wrap">
            <div className="compact-usage-slot__scroll">
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
            </div>
          </div>
        </section>
      </div>
    </>
  );

  if (isMini) {
    return (
      <div
        className="compact-frame compact-frame--mini"
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
        <div className="compact-frame__backdrop" aria-hidden="true" />
        <div className="compact-frame__ornaments" aria-hidden="true" />
        <CompactMiniRail state={state} />
      </div>
    );
  }

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
      {renderExpandedContent(true)}
    </div>
  );
}
