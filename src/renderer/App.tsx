// Renderer root.
//
// The renderer hosts two visually distinct UIs in the same bundle —
// the 360px-wide compact widget and the 760×560 expanded window
// (windows.ts#createCompactWindow / createExpandedWindow). We pick
// between them on mount with a simple `window.innerWidth` threshold
// rather than a media-query library; the compact window is
// `resizable: false` so the classification is effectively static
// after first paint.
//
// Compact mode wires real data:
//   • `window.desktop.getDashboard()` for the initial paint
//   • `window.desktop.on('dashboard.updated', ...)` for live ticks
//
// Expanded mode is still a placeholder; the tabbed UI lands with
// task 5.8 onward. Both branches must boot under the same renderer
// bundle, including environments where `window.desktop` is not
// available (e.g. unit tests under jsdom or a misconfigured preload),
// so every consumer of the bridge guards for `undefined`.
//
// References:
//   • design.md §Window Strategy, §Compact Window Boot — First Render
//   • PLAN.md §UI Implementation Guide §紧凑首页

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Settings as SettingsIcon,
  RefreshCw,
} from 'lucide-react';

import { WidgetShell } from './components/WidgetShell';
import { NodeTable } from './components/NodeTable';
import { QuickActionsPanel } from './components/QuickActionsPanel';
import { UsagePanel } from './components/UsagePanel';
import { SettingsView } from './components/SettingsView';
import { TelemetryWave } from './components/TelemetryWave';
import { useT } from './lib/i18n';
import type { TranslationKey } from '../i18n';
import type {
  AppearanceSettings,
  DashboardState,
  NodeView,
  Unsubscribe,
} from './lib/types';

// Fallback applied while the initial `getSettings()` call is in
// flight, or when the preload bridge is missing entirely (jsdom
// tests, broken Electron config). Matches the seed value shipped by
// `buildDefaultAppSettings()` in the main process so a renderer
// that never reaches the bridge still produces a coherent UI.
const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorMode: 'dark',
  compactTheme: 'mint-monitor',
  fontScale: 1,
  compactZoom: 1,
};

/**
 * Subscribe to `settings.updated` and the initial `getSettings()` so
 * both windows track appearance changes live. Centralised here so
 * the compact and expanded roots share the same reducer/effects.
 */
function useAppearance(): AppearanceSettings {
  const [appearance, setAppearance] = useState<AppearanceSettings>(
    DEFAULT_APPEARANCE,
  );

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      return;
    }
    let cancelled = false;
    desktop
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        if (s.appearance) {
          setAppearance(s.appearance);
        }
      })
      .catch(() => {
        // Non-fatal: keep DEFAULT_APPEARANCE so the UI still renders.
      });

    const unsub = desktop.on('settings.updated', (next) => {
      if (!cancelled && next.appearance) {
        setAppearance(next.appearance);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return appearance;
}

const COMPACT_WIDTH = 360;
const EXPANDED_WIDTH = 760;

// Midpoint between the two designed widths. Any window narrower than
// this is treated as compact; anything wider is expanded.
const MODE_THRESHOLD = (COMPACT_WIDTH + EXPANDED_WIDTH) / 2;

type WindowMode = 'compact' | 'expanded';
type CompactDisplayMode = 'expanded' | 'mini';

interface CompactWindowSize {
  readonly width: number;
  readonly height: number;
}

const COMPACT_MINI_WIDTH = 56;

function compactModeTargetSize(mode: CompactDisplayMode): CompactWindowSize | null {
  if (mode === 'mini') {
    const miniRail = document.querySelector<HTMLElement>('.compact-mini-rail');
    if (!miniRail) {
      return null;
    }
    return {
      width: COMPACT_MINI_WIDTH,
      height: Math.ceil(miniRail.scrollHeight + 8),
    };
  }

  const expandedContent =
    document.querySelector<HTMLElement>('.compact-frame__content');
  if (!expandedContent) {
    return null;
  }
  return {
    width: COMPACT_WIDTH,
    // Expanded content scrollHeight includes inner padding. Add the
    // 6 px frame margin on each side.
    height: Math.ceil(expandedContent.scrollHeight + 12),
  };
}

function detectWindowMode(): WindowMode {
  if (typeof window === 'undefined') {
    return 'compact';
  }
  if (isLocalBrowserPreview()) {
    return 'compact';
  }
  // Main process passes mode via URL hash (#compact or #expanded)
  const hash = window.location.hash.replace('#', '');
  if (hash === 'expanded') return 'expanded';
  if (hash === 'compact') return 'compact';
  // Fallback: use window width
  const width = window.outerWidth || window.innerWidth;
  return width < MODE_THRESHOLD ? 'compact' : 'expanded';
}

function isLocalBrowserPreview(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    !window.desktop &&
    (window.location.hostname === '127.0.0.1' ||
      window.location.hostname === 'localhost')
  );
}

function previewDashboardState(): DashboardState {
  return {
    status: 'healthy',
    statusLabel: '外网正常',
    generatedAt: Date.now(),
    router: { ok: true, lastChange: Date.now() - 60_000 },
    openclash: { tcpOk: true, apiOk: true, mode: 'rule' },
    currentNode: {
      group: '日本04',
      node: '日本A04 | IEPL',
      avgLatencyMs: 128,
      probeResults: [],
      successRate5: 1,
      sparkline: [31, 33, 30, 32, 31, 128, 34, 30, 32, 31, 33, 30, 32, 31, 34, 30],
    },
    usageToday: { codex: 0, gemini: 0, opencode: 0 },
  };
}

// ---------------------------------------------------------------------------
// Network glance helpers
// ---------------------------------------------------------------------------

/**
 * Format a latency value as a bare integer for the giant numeric
 * readout on the network glance card. Returns "—" when the input is
 * not a finite number so the metric slot stays the same width.
 */
function formatLatencyNumber(latencyMs: number | null): string {
  if (latencyMs === null || !Number.isFinite(latencyMs)) {
    return '—';
  }
  return String(Math.round(latencyMs));
}

function sparklineMin(samples: number[]): number | null {
  if (samples.length === 0) return null;
  let min = samples[0]!;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]! < min) min = samples[i]!;
  }
  return min;
}

function sparklineMax(samples: number[]): number | null {
  if (samples.length === 0) return null;
  let max = samples[0]!;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]! > max) max = samples[i]!;
  }
  return max;
}

/**
 * Map a `HealthStatus` to one of four visual tones used by the new
 * network card. Aligns with the StatusHero helper, but kept local so
 * App.tsx never has to import the StatusHero component just to
 * recover this single mapping.
 */
function networkStatusTone(status: DashboardState['status']): 'healthy' | 'warn' | 'bad' | 'critical' {
  switch (status) {
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

type OpsSignalTone = 'ok' | 'warn' | 'bad' | 'neutral';

function padClock(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatOpsTimestamp(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return '—';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return [
    padClock(date.getHours()),
    padClock(date.getMinutes()),
    padClock(date.getSeconds()),
  ].join(':');
}

export function formatOpsSuccessRate(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return '—';
  }
  const clamped = Math.min(1, Math.max(0, rate));
  return `${Math.round(clamped * 100)}%`;
}

export function openclashApiTone(
  apiOk: DashboardState['openclash']['apiOk'] | null | undefined,
): OpsSignalTone {
  if (apiOk === true) return 'ok';
  if (apiOk === 'auth_error') return 'warn';
  return 'bad';
}

function booleanOpsTone(ok: boolean | null | undefined): OpsSignalTone {
  if (ok === true) return 'ok';
  if (ok === false) return 'bad';
  return 'neutral';
}

function openclashApiLabel(
  apiOk: DashboardState['openclash']['apiOk'] | null | undefined,
): string {
  if (apiOk === true) return 'API 正常';
  if (apiOk === 'auth_error') return 'API 鉴权';
  return 'API 失败';
}

export function App(): JSX.Element | null {
  const [mode, setMode] = useState<WindowMode>(detectWindowMode);
  const appearance = useAppearance();

  // Keep the classification in sync with the (rare) runtime window
  // resize. The compact window is `resizable: false` so this hook is
  // mostly a safety net for the expanded case.
  useEffect(() => {
    const handler = (): void => {
      setMode(detectWindowMode());
    };
    handler();
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('resize', handler);
    };
  }, []);

  // Toggle a `body` class so the global stylesheet can pick the
  // right background. Doing this from React keeps the source of
  // truth (the detected mode) in one place.
  useEffect(() => {
    const { body } = document;
    body.classList.toggle('local-browser-preview', isLocalBrowserPreview());
    if (mode === 'expanded') {
      body.classList.add('mode-expanded');
      body.classList.remove('mode-compact', 'expanded', 'compact');
    } else {
      body.classList.add('mode-compact');
      body.classList.remove('mode-expanded', 'expanded', 'compact');
    }
  }, [mode]);

  // Mirror the live appearance onto the document element so theme
  // CSS scoped to `[data-color-mode]` / `[data-compact-theme]` can
  // resolve without re-rendering every component. We also keep them
  // on body for any selector that already targets the body.
  useEffect(() => {
    const root = document.documentElement;
    const { body } = document;
    root.dataset.colorMode = appearance.colorMode;
    root.dataset.compactTheme = appearance.compactTheme;
    root.style.setProperty('--ui-font-scale', String(appearance.fontScale));
    body.dataset.colorMode = appearance.colorMode;
    body.dataset.compactTheme = appearance.compactTheme;
    body.style.setProperty('--ui-font-scale', String(appearance.fontScale));
  }, [appearance.colorMode, appearance.compactTheme, appearance.fontScale]);

  if (mode === 'compact') {
    return <CompactRoot appearance={appearance} />;
  }

  return <ExpandedRoot appearance={appearance} />;
}// ---------------------------------------------------------------------------
// Compact root — fetches the dashboard and subscribes to live updates.
// ---------------------------------------------------------------------------

/**
 * Compact-window data root.
 *
 * Three states are surfaced in the UI:
 *   • `desktop` bridge missing → render a small notice. This only
 *     happens in environments where the preload script never ran
 *     (jsdom unit tests, a broken Electron config); production users
 *     should never see it. We surface the failure rather than silent
 *     `null` so it shows up in screenshots.
 *   • Initial fetch in flight → render nothing. The frameless
 *     transparent window is invisible at this point; flashing a
 *     loading spinner against an arbitrary desktop wallpaper is
 *     worse than waiting.
 *   • `state` loaded → render `<WidgetShell state={...} />`.
 */
function CompactRoot({
  appearance,
}: {
  readonly appearance: AppearanceSettings;
}): JSX.Element | null {
  const t = useT();
  const [state, setState] = useState<DashboardState | null>(() => (
    isLocalBrowserPreview() ? previewDashboardState() : null
  ));
  const [bridgeMissing, setBridgeMissing] = useState<boolean>(false);
  const [displayMode, setDisplayMode] = useState<CompactDisplayMode>('expanded');

  // Apply the user's compact-window zoom locally via the preload
  // bridge's `webFrame.setZoomFactor` wrapper. This is scoped to
  // THIS renderer process and never touches the shared
  // `(session, host)` host-zoom-map — important because the expanded
  // window shares the same `file://` host in production, and using
  // `webContents.setZoomFactor` from the main process would leak the
  // compact zoom into it. The expanded root deliberately does not
  // run this hook so it stays at 1.0.
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop || !desktop.setLocalZoomFactor) {
      return;
    }
    desktop.setLocalZoomFactor(appearance.compactZoom);
  }, [appearance.compactZoom]);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      if (isLocalBrowserPreview()) {
        setState(previewDashboardState());
        return;
      }
      setBridgeMissing(true);
      return;
    }

    // Track unmount so an in-flight `getDashboard()` resolution does
    // not call `setState` on a torn-down component.
    let cancelled = false;
    let unsubscribe: Unsubscribe | null = null;

    desktop
      .getDashboard()
      .then((initial) => {
        if (!cancelled) {
          setState(initial);
        }
      })
      .catch((err: unknown) => {
        // The bridge surfaces typed `IpcEnvelopeError`s; we don't
        // have a UI for them yet (task 9.x will add error states),
        // so we surface to the console and leave `state` null. The
        // next push from `dashboard.updated` will recover the UI as
        // soon as the main process produces a valid snapshot.
        // eslint-disable-next-line no-console -- diagnostic only
        console.error('[App] getDashboard() failed:', err);
      });

    unsubscribe = desktop.on('dashboard.updated', (next) => {
      if (!cancelled) {
        setState(next);
      }
    });

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  const displayModeRef = useRef<CompactDisplayMode>(displayMode);
  displayModeRef.current = displayMode;

  const requestCompactWindowSize = useCallback((size: CompactWindowSize): void => {
    const desktop = window.desktop;
    const isPreview = isLocalBrowserPreview();

    if (isPreview) {
      const root = document.getElementById('root');
      document.body.style.width = `${size.width}px`;
      document.body.style.height = `${size.height}px`;
      if (root) {
        root.style.width = `${size.width}px`;
        root.style.height = `${size.height}px`;
      }
    }

    if (desktop && 'resizeCompactWindow' in desktop) {
      desktop.resizeCompactWindow(size).catch(() => {});
    }
  }, []);

  const handleDisplayModeChange = useCallback((nextMode: CompactDisplayMode): void => {
    const currentMode = displayModeRef.current;
    if (nextMode === currentMode) {
      return;
    }

    setDisplayMode(nextMode);
  }, []);

  useEffect(() => {
    let lastSize: { width: number; height: number } | null = null;
    let raf = 0;

    /**
     * Tolerate ±1 CSS pixel of jitter when comparing the new
     * measurement against the last-applied one. Without this guard
     * the loop oscillates: a sub-pixel layout difference (e.g.
     * `Math.ceil` rounding when zoom ≠ 1) causes the renderer to
     * keep re-requesting a window resize, which triggers the
     * `ResizeObserver` again, which re-measures, etc.
     */
    const SIZE_EPSILON = 1;
    const sameAsLast = (next: { width: number; height: number }): boolean => {
      if (lastSize === null) return false;
      return (
        Math.abs(lastSize.width - next.width) <= SIZE_EPSILON &&
        Math.abs(lastSize.height - next.height) <= SIZE_EPSILON
      );
    };

    const measure = (): void => {
      raf = 0;
      const currentMode = displayModeRef.current;
      const measuredSize = compactModeTargetSize(currentMode);
      if (!measuredSize) {
        return;
      }

      if (sameAsLast(measuredSize)) {
        return;
      }
      lastSize = measuredSize;

      requestCompactWindowSize(measuredSize);
    };

    const schedule = (): void => {
      if (raf !== 0) {
        return;
      }
      raf = window.requestAnimationFrame(measure);
    };

    schedule();

    const observer = new ResizeObserver(schedule);
    // We deliberately observe ONLY content elements here, never the
    // outer `.compact-frame` / `.compact-frame--mini` / `.compact-mini-rail`
    // root. Those roots are sized as `100%` of the BrowserWindow body
    // (via `height: calc(100% - 8px)` on the mini frame), so observing
    // them creates a feedback loop:
    //   render → measure → request main resize → BrowserWindow grows →
    //   `.compact-frame--mini` grows → ResizeObserver fires → measure
    //   again with a slightly different rounded value → repeat.
    // The actual content height is reported correctly by
    // `.compact-frame__content` (expanded mode) and by the inner
    // `.compact-mini-rail` *children* (mini mode), neither of which
    // depend on the outer window size.
    const content = document.querySelector<HTMLElement>('.compact-frame__content');
    if (content) {
      observer.observe(content);
    }
    const usageSlot = document.querySelector<HTMLElement>('.compact-usage-slot');
    if (usageSlot) {
      observer.observe(usageSlot);
    }
    // Mini-rail layout is driven by its child count + spacing, not by
    // the outer frame, so observing the rail itself is safe — its
    // intrinsic height does not track the BrowserWindow height. We
    // skip it on themes / states where it isn't mounted.
    const miniRail = document.querySelector<HTMLElement>('.compact-mini-rail');
    if (miniRail) {
      observer.observe(miniRail);
    }

    return () => {
      observer.disconnect();
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [
    state,
    displayMode,
    appearance.colorMode,
    appearance.compactTheme,
    appearance.fontScale,
    appearance.compactZoom,
    requestCompactWindowSize,
  ]);

  if (bridgeMissing) {
    return (
      <div
        className="boot boot--compact"
        data-testid="app-root"
        data-mode="compact"
        data-state="bridge-missing"
        data-color-mode={appearance.colorMode}
        data-compact-theme={appearance.compactTheme}
      >
        preload bridge unavailable
      </div>
    );
  }

  if (!state) {
    // First paint: show a minimal loading state so the transparent
    // window is at least visible. Returning null would make the
    // transparent frameless window completely invisible.
    return (
      <div
        className="boot boot--compact"
        data-testid="app-root"
        data-mode="compact"
        data-state="loading"
        data-color-mode={appearance.colorMode}
        data-compact-theme={appearance.compactTheme}
      >
        <div style={{ padding: '16px', color: '#ccc', fontSize: '13px' }}>
          {t('boot.loading')}
        </div>
      </div>
    );
  }

  return (
    <WidgetShell
      state={state}
      appearance={appearance}
      displayMode={displayMode}
      onDisplayModeChange={handleDisplayModeChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Expanded root — refreshed editorial layout.
//
// Composition (top → bottom):
//   ┌──────────────────────────────────────────────────────────────┐
//   │  Topbar  ◇ MONITOR · network & ai watchdog       tabs · ↻   │
//   ├──────────────────────────────────────────────────────────────┤
//   │  Tab content                                                 │
//   │   • network  →  network glance card  +  node table           │
//   │   • usage    →  UsagePanel (quota + token breakdown)         │
//   │   • settings →  SettingsView                                 │
//   └──────────────────────────────────────────────────────────────┘
//
// The compact widget's network glance is reused on the network tab
// so the two windows feel like one product, but it stays scoped to
// that tab — the AI quota lives on the usage tab where it belongs.
// ---------------------------------------------------------------------------

type ExpandedTab = 'network' | 'usage' | 'settings';

interface TabDef {
  readonly id: ExpandedTab;
  readonly labelKey: TranslationKey;
  readonly icon: JSX.Element;
}

const TABS: readonly TabDef[] = [
  { id: 'network', labelKey: 'expanded.tab.network', icon: <Activity size={15} strokeWidth={1.75} /> },
  { id: 'usage', labelKey: 'expanded.tab.usage', icon: <BarChart3 size={15} strokeWidth={1.75} /> },
  { id: 'settings', labelKey: 'expanded.tab.settings', icon: <SettingsIcon size={15} strokeWidth={1.75} /> },
];

// ---------------------------------------------------------------------------
// GroupTabBar — scrollable tab bar with fade edges and arrow buttons
// ---------------------------------------------------------------------------

function GroupTabBar({
  groups,
  selectedName,
  onSelect,
  ariaLabel,
}: {
  readonly groups: ReadonlyArray<{ name: string }>;
  readonly selectedName: string | null;
  readonly onSelect: (name: string) => void;
  readonly ariaLabel: string;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      ro.disconnect();
    };
  }, [updateScrollState, groups]);

  // Scroll active tab into view on selection change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || selectedName === null) return;
    const activeTab = el.querySelector<HTMLElement>('[aria-selected="true"]');
    if (activeTab) {
      const activeLeft = activeTab.offsetLeft;
      const activeRight = activeLeft + activeTab.offsetWidth;
      const viewportLeft = el.scrollLeft;
      const viewportRight = viewportLeft + el.clientWidth;

      if (activeLeft < viewportLeft) {
        el.scrollTo({ left: activeLeft, behavior: 'smooth' });
      } else if (activeRight > viewportRight) {
        el.scrollTo({
          left: activeRight - el.clientWidth,
          behavior: 'smooth',
        });
      }
    }
  }, [selectedName]);

  // Convert vertical wheel to horizontal scroll.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, []);

  const scrollBy = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.6;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
  }, []);

  return (
    <div className="ex__group-bar">
      {canScrollLeft && (
        <button
          type="button"
          className="ex__group-arrow"
          onClick={() => scrollBy('left')}
          aria-label="Scroll left"
          tabIndex={-1}
        >
          <ChevronLeft size={13} strokeWidth={2} />
        </button>
      )}

      <div
        ref={scrollRef}
        className="ex__group-track"
        role="tablist"
        aria-label={ariaLabel}
        onWheel={handleWheel}
      >
        {groups.map((g) => (
          <button
            key={g.name}
            type="button"
            role="tab"
            aria-selected={g.name === selectedName}
            className={[
              'ex__group-tab',
              g.name === selectedName ? 'ex__group-tab--active' : '',
            ].join(' ')}
            onClick={() => onSelect(g.name)}
          >
            {g.name}
          </button>
        ))}
      </div>

      {canScrollRight && (
        <button
          type="button"
          className="ex__group-arrow"
          onClick={() => scrollBy('right')}
          aria-label="Scroll right"
          tabIndex={-1}
        >
          <ChevronRight size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function ExpandedRoot({
  appearance,
}: {
  readonly appearance: AppearanceSettings;
}): JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<ExpandedTab>('network');
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [currentGroup, setCurrentGroup] = useState<string | null>(null);
  const [switchConfirm, setSwitchConfirm] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [availableGroups, setAvailableGroups] = useState<Array<{ name: string; nodes: NodeView[] }>>([]);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);

  const reloadNodes = useCallback(async (): Promise<void> => {
    const desktop = window.desktop;
    if (!desktop) return;
    try {
      const details = await desktop.getOpenClashDetails();
      const groups = details.groups.map((g) => ({ name: g.name, nodes: g.nodes }));
      setAvailableGroups(groups);

      if (groups.length === 0) {
        setNodes([]);
        setCurrentGroup(null);
        setSelectedGroupName(null);
        return;
      }

      // If the currently selected group still exists, keep it;
      // otherwise fall back to the first group.
      const stillExists =
        selectedGroupName !== null &&
        groups.some((g) => g.name === selectedGroupName);
      const activeName = stillExists ? selectedGroupName! : groups[0]!.name;
      const activeGroup = groups.find((g) => g.name === activeName) ?? groups[0]!;

      setSelectedGroupName(activeName);
      setNodes(activeGroup.nodes);
      setCurrentGroup(activeName);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[ExpandedRoot] getOpenClashDetails failed:', err);
    }
  }, [selectedGroupName]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    const desktop = window.desktop;
    if (!desktop) return;
    setRefreshing(true);
    try {
      await desktop.refreshNow();
      await reloadNodes();
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[ExpandedRoot] refreshNow failed:', err);
    } finally {
      // Keep the spin animation visible for at least a beat so the
      // click registers visually.
      setTimeout(() => setRefreshing(false), 350);
    }
  }, [reloadNodes]);

  const handleGroupSelect = useCallback(
    (groupName: string) => {
      const group = availableGroups.find((g) => g.name === groupName);
      if (group) {
        setSelectedGroupName(groupName);
        setNodes(group.nodes);
        setCurrentGroup(groupName);
      }
    },
    [availableGroups],
  );

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      setError('preload bridge unavailable');
      return;
    }

    let cancelled = false;

    desktop
      .getDashboard()
      .then((d) => {
        if (!cancelled) setDashboard(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(`getDashboard: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    desktop
      .getSettings()
      .then((s) => {
        if (!cancelled) setSwitchConfirm(s.switchConfirmation);
      })
      .catch(() => {
        /* non-fatal */
      });

    void reloadNodes();

    const unsub = desktop.on('dashboard.updated', (d) => {
      if (!cancelled) {
        setDashboard(d);
        // Refetch the live OpenClash details on every push so the
        // NodeTable and current-group label keep up with collector
        // ticks and config-switch completions. Without this, the
        // expanded window stays pinned to whatever `getOpenClashDetails`
        // returned at mount — `dashboard.updated` itself doesn't carry
        // the per-node rows.
        void reloadNodes();
      }
    });

    const unsubTab = desktop.on('navigate-tab', (targetTab) => {
      if (
        !cancelled &&
        (targetTab === 'network' || targetTab === 'usage' || targetTab === 'settings')
      ) {
        setTab(targetTab);
      }
    });

    return () => {
      cancelled = true;
      unsub();
      unsubTab();
    };
  }, [reloadNodes]);

  return (
    <div
      className={tab === 'network' ? 'ex ex--network-ops' : 'ex'}
      data-testid="expanded-root"
      data-color-mode={appearance.colorMode}
      data-compact-theme={appearance.compactTheme}
    >
      {/* ── Topbar ────────────────────────────────────────────── */}
      <header className="ex__topbar">
        <div className="ex__brand">
          <span className="ex__brand-mark" aria-hidden="true">◆</span>
          <span className="ex__brand-name">MONITOR</span>
          <span className="ex__brand-tag">network · ai watch</span>
        </div>

        <nav className="ex__tabs" role="tablist" aria-label={t('expanded.aria.mainNav')}>
          {TABS.map((tabDef) => {
            const active = tab === tabDef.id;
            return (
              <button
                key={tabDef.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`ex__tab${active ? ' ex__tab--active' : ''}`}
                onClick={() => setTab(tabDef.id)}
              >
                <span className="ex__tab-icon" aria-hidden="true">{tabDef.icon}</span>
                <span className="ex__tab-label">{t(tabDef.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          className={`ex__refresh${refreshing ? ' ex__refresh--spin' : ''}`}
          onClick={() => void handleRefresh()}
          aria-label={t('expanded.aria.refreshNow')}
          title={t('expanded.refresh.title')}
          disabled={refreshing}
        >
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      </header>

      {/* ── Tab content ───────────────────────────────────────── */}
      <main
        className="ex__main"
        role="tabpanel"
        aria-label={(() => {
          const current = TABS.find((tabDef) => tabDef.id === tab);
          return current ? t(current.labelKey) : undefined;
        })()}
      >
        {error && (
          <div className="ex__error" role="alert">
            <span className="ex__error-mark" aria-hidden="true">!</span>
            <span>{error}</span>
          </div>
        )}

        {tab === 'network' && (
          <div className="ops-network">
            <section
              className="ops-network__status-strip"
              aria-label="网络运行状态"
              data-status={dashboard ? networkStatusTone(dashboard.status) : 'unknown'}
            >
              <div className="ops-network__status-cell ops-network__status-cell--health">
                <span
                  className="ops-network__status-dot"
                  aria-hidden="true"
                  data-status={dashboard ? networkStatusTone(dashboard.status) : 'unknown'}
                />
                <span className="ops-network__status-kicker">HEALTH</span>
                <strong>
                  {dashboard
                    ? t(('dashboard.health.' + dashboard.status) as TranslationKey)
                    : t('dashboard.network.waitingData')}
                </strong>
              </div>

              <div className="ops-network__status-cell">
                <span className="ops-network__status-kicker">LATENCY</span>
                <strong>
                  {formatLatencyNumber(dashboard?.currentNode.avgLatencyMs ?? null)}
                  <span>ms</span>
                </strong>
              </div>

              <div className="ops-network__status-cell">
                <span className="ops-network__status-kicker">GROUP</span>
                <strong>{currentGroup ?? dashboard?.currentNode.group ?? '—'}</strong>
              </div>

              <div className="ops-network__status-cell ops-network__status-cell--wide">
                <span className="ops-network__status-kicker">CURRENT NODE</span>
                <strong title={dashboard?.currentNode.node ?? undefined}>
                  {dashboard?.currentNode.node ?? t('dashboard.network.waitingNodeData')}
                </strong>
              </div>

              <div className="ops-network__status-cell">
                <span className="ops-network__status-kicker">MODE</span>
                <strong>{dashboard?.openclash.mode ?? '—'}</strong>
              </div>

              <div className="ops-network__status-cell">
                <span className="ops-network__status-kicker">UPDATED</span>
                <strong>{formatOpsTimestamp(dashboard?.generatedAt)}</strong>
              </div>
            </section>

            <div className="ops-network__workspace">
              <div className="ops-network__primary">
                <section className="ops-network__panel ops-network__panel--telemetry">
                  <header className="ops-network__panel-head">
                    <div>
                      <span className="ops-network__eyebrow">{t('dashboard.network.eyebrow')}</span>
                      <h2 className="ops-network__title">实时链路遥测</h2>
                    </div>
                    <div className="ops-network__panel-head-right">
                      {dashboard && (
                        <div className="ops-network__pills" aria-label="连通性状态">
                          <span
                            className="ops-network__pill"
                            data-tone={booleanOpsTone(dashboard.router.ok)}
                          >
                            <span className="ops-network__pill-dot" aria-hidden="true" />
                            <span>Router</span>
                            <strong>{dashboard.router.ok ? 'Online' : 'Offline'}</strong>
                          </span>
                          <span
                            className="ops-network__pill"
                            data-tone={booleanOpsTone(dashboard.openclash.tcpOk)}
                          >
                            <span className="ops-network__pill-dot" aria-hidden="true" />
                            <span>TCP</span>
                            <strong>{dashboard.openclash.tcpOk ? 'OK' : 'Down'}</strong>
                          </span>
                          <span
                            className="ops-network__pill"
                            data-tone={openclashApiTone(dashboard.openclash.apiOk)}
                          >
                            <span className="ops-network__pill-dot" aria-hidden="true" />
                            <span>OpenClash</span>
                            <strong>{openclashApiLabel(dashboard.openclash.apiOk)}</strong>
                          </span>
                          <span className="ops-network__pill" data-tone="neutral">
                            <span className="ops-network__pill-dot" aria-hidden="true" />
                            <span>S5</span>
                            <strong>{formatOpsSuccessRate(dashboard.currentNode.successRate5)}</strong>
                          </span>
                        </div>
                      )}
                      {dashboard?.currentNode.sparkline.length ? (
                        <span
                          className="ops-network__range"
                          aria-label={t('dashboard.network.latencyRangeAria')}
                        >
                          {formatLatencyNumber(sparklineMin(dashboard.currentNode.sparkline))}
                          <span>–</span>
                          {formatLatencyNumber(sparklineMax(dashboard.currentNode.sparkline))}
                          <em>ms</em>
                        </span>
                      ) : null}
                    </div>
                  </header>

                  {dashboard ? (
                    <div className="ops-network__chart" aria-hidden="true">
                      <TelemetryWave
                        data={dashboard.currentNode.sparkline}
                        width={760}
                        height={190}
                        strokeWidth={1.85}
                      />
                    </div>
                  ) : (
                    <div className="ops-network__placeholder">
                      {t('dashboard.network.waitingData')}
                    </div>
                  )}
                </section>

                {availableGroups.length > 1 && (
                  <div className="ops-network__groups">
                    <GroupTabBar
                      groups={availableGroups}
                      selectedName={selectedGroupName}
                      onSelect={handleGroupSelect}
                      ariaLabel={t('dashboard.network.groupSelectorAria')}
                    />
                  </div>
                )}

                <section
                  className="ops-network__panel ops-network__panel--nodes ex__panel--network"
                  aria-label={t('dashboard.network.nodeListAria')}
                >
                  <header className="ops-network__panel-head">
                    <div>
                      <span className="ops-network__eyebrow">NODE LIST</span>
                      <h2 className="ops-network__title">
                        {t('dashboard.network.nodeTitle')}
                      </h2>
                    </div>
                    <div className="ops-network__panel-meta">
                      <span>{nodes.length}</span>
                      {currentGroup && <strong>{currentGroup}</strong>}
                    </div>
                  </header>

                  <NodeTable
                    nodes={nodes}
                    currentNode={dashboard?.currentNode.node ?? null}
                    groupName={currentGroup ?? dashboard?.currentNode.group ?? null}
                    switchConfirmEnabled={switchConfirm}
                  />
                </section>
              </div>

              <aside className="ops-network__side" aria-label="配置切换">
                <header className="ops-network__side-head">
                  <span className="ops-network__eyebrow">CONTROL</span>
                  <h2 className="ops-network__side-title">配置切换</h2>
                </header>
                <QuickActionsPanel healthStatus={dashboard?.status ?? 'healthy'} />
              </aside>
            </div>
          </div>
        )}

        {tab === 'usage' && (
          <section className="ex__panel ex__panel--usage">
            <UsagePanel />
          </section>
        )}

        {tab === 'settings' && (
          <section className="ex__panel ex__panel--settings">
            <SettingsView />
          </section>
        )}
      </main>
    </div>
  );
}
