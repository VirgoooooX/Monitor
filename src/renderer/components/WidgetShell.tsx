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

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppearanceSettings, DashboardState } from '../lib/types';
import { formatTokens } from '../lib/format';
import { StatusHero } from './StatusHero';
import { Sparkline } from './Sparkline';
import { QuotaStrip } from './QuotaStrip';
import { CompactMiniRail } from './CompactMiniRail';
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';

interface WidgetShellProps {
  readonly state: DashboardState;
  readonly appearance?: AppearanceSettings | undefined;
  readonly displayMode?: 'full' | 'expanded' | 'mini';
  readonly onDisplayModeChange?: (mode: 'full' | 'expanded' | 'mini') => void;
}

interface ScrollCueState {
  scrollable: boolean;
  thumbTop: number;
  thumbHeight: number;
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

export function WidgetShell({
  state,
  appearance,
  displayMode = 'full',
  onDisplayModeChange,
}: WidgetShellProps): JSX.Element {
  const line = nodeLine(state);
  const usage = state.usageToday;
  const isMini = displayMode === 'mini';
  const isExpanded = displayMode === 'expanded';
  const usageScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollCue, setScrollCue] = useState<ScrollCueState>({
    scrollable: false,
    thumbTop: 0,
    thumbHeight: 0,
  });

  useEffect(() => {
    const scrollEl = usageScrollRef.current;
    if (isMini || isExpanded || !scrollEl) {
      setScrollCue({ scrollable: false, thumbTop: 0, thumbHeight: 0 });
      return;
    }

    let raf = 0;
    const update = (): void => {
      raf = 0;
      const { clientHeight, scrollHeight, scrollTop } = scrollEl;
      const scrollable = scrollHeight > clientHeight + 1;
      if (!scrollable) {
        setScrollCue({ scrollable: false, thumbTop: 0, thumbHeight: 0 });
        return;
      }

      const minThumbHeight = 18;
      const thumbHeight = Math.max(
        minThumbHeight,
        Math.round((clientHeight / scrollHeight) * clientHeight),
      );
      const maxThumbTop = Math.max(0, clientHeight - thumbHeight);
      const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
      const thumbTop = Math.round((scrollTop / maxScrollTop) * maxThumbTop);

      setScrollCue((current) => {
        if (
          current.scrollable &&
          current.thumbTop === thumbTop &&
          current.thumbHeight === thumbHeight
        ) {
          return current;
        }
        return { scrollable: true, thumbTop, thumbHeight };
      });
    };

    const schedule = (): void => {
      if (raf !== 0) {
        return;
      }
      raf = window.requestAnimationFrame(update);
    };

    schedule();
    scrollEl.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollEl);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(scrollEl, { childList: true, subtree: true });

    return () => {
      scrollEl.removeEventListener('scroll', schedule);
      observer.disconnect();
      mutationObserver.disconnect();
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [isExpanded, isMini, usage.codex, usage.gemini, usage.opencode]);

  const handleClick = (): void => {
    if (isMini) {
      onDisplayModeChange?.('full');
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

      {/* Mini mode toggle button on top right */}
      <button
        type="button"
        className="compact-mini-toggle-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDisplayModeChange?.('mini');
        }}
        title="切换到极简模式"
        aria-label="切换到极简模式"
      >
        <ArrowUpRight size={14} />
      </button>

      {/* Bottom center expand toggle button */}
      {(isExpanded || scrollCue.scrollable) && (
        <button
          type="button"
          className="compact-expand-toggle-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDisplayModeChange?.(isExpanded ? 'full' : 'expanded');
          }}
          title={isExpanded ? '收起用量' : '展开全部用量'}
          aria-label={isExpanded ? '收起用量' : '展开全部用量'}
        >
          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      )}

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
          <div className="compact-usage-slot__scroll-wrap">
            <div className="compact-usage-slot__scroll" ref={usageScrollRef}>
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

            <span
              className="compact-scroll-cue"
              data-scrollable={scrollCue.scrollable}
              style={{
                '--scroll-cue-thumb-top': `${scrollCue.thumbTop}px`,
                '--scroll-cue-thumb-height': `${scrollCue.thumbHeight}px`,
              } as CSSProperties}
              aria-hidden="true"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
