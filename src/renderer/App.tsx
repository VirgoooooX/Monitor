// Renderer root.
//
// The renderer hosts two visually distinct UIs in the same bundle —
// the 360×240 compact widget and the 760×560 expanded window
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Settings as SettingsIcon,
  RefreshCw,
} from 'lucide-react';

import { WidgetShell } from './components/WidgetShell';
import { NodeTable } from './components/NodeTable';
import { QuickActionsPanel } from './components/QuickActionsPanel';
import { UsagePanel } from './components/UsagePanel';
import { SettingsView } from './components/SettingsView';
import { StatusHero } from './components/StatusHero';
import { Sparkline } from './components/Sparkline';
import { formatLatency } from './lib/format';
import type { DashboardState, NodeView, Unsubscribe } from './lib/types';

const COMPACT_WIDTH = 360;
const EXPANDED_WIDTH = 760;

// Midpoint between the two designed widths. Any window narrower than
// this is treated as compact; anything wider is expanded.
const MODE_THRESHOLD = (COMPACT_WIDTH + EXPANDED_WIDTH) / 2;

type WindowMode = 'compact' | 'expanded';

function detectWindowMode(): WindowMode {
  if (typeof window === 'undefined') {
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

export function App(): JSX.Element | null {
  const [mode, setMode] = useState<WindowMode>(detectWindowMode);

  // Keep the classification in sync with the (rare) runtime window
  // resize. The compact window is `resizable: false` so this hook is
  // mostly a safety net for the expanded case.
  useEffect(() => {
    const handler = (): void => {
      setMode(detectWindowMode());
    };
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
    if (mode === 'expanded') {
      body.classList.add('mode-expanded');
      body.classList.remove('mode-compact', 'expanded', 'compact');
    } else {
      body.classList.add('mode-compact');
      body.classList.remove('mode-expanded', 'expanded', 'compact');
    }
  }, [mode]);

  if (mode === 'compact') {
    return <CompactRoot />;
  }

  return <ExpandedRoot />;
}

// ---------------------------------------------------------------------------
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
function CompactRoot(): JSX.Element | null {
  const [state, setState] = useState<DashboardState | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState<boolean>(false);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
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

  if (bridgeMissing) {
    return (
      <div
        className="boot boot--compact"
        data-testid="app-root"
        data-mode="compact"
        data-state="bridge-missing"
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
      >
        <div style={{ padding: '16px', color: '#ccc', fontSize: '13px' }}>
          加载中…
        </div>
      </div>
    );
  }

  return <WidgetShell state={state} />;
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
  readonly label: string;
  readonly icon: JSX.Element;
}

const TABS: readonly TabDef[] = [
  { id: 'network', label: '网络', icon: <Activity size={15} strokeWidth={1.75} /> },
  { id: 'usage', label: '用量', icon: <BarChart3 size={15} strokeWidth={1.75} /> },
  { id: 'settings', label: '设置', icon: <SettingsIcon size={15} strokeWidth={1.75} /> },
];

function ExpandedRoot(): JSX.Element {
  const [tab, setTab] = useState<ExpandedTab>('network');
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [currentGroup, setCurrentGroup] = useState<string | null>(null);
  const [switchConfirm, setSwitchConfirm] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const reloadNodes = useCallback(async (): Promise<void> => {
    const desktop = window.desktop;
    if (!desktop) return;
    try {
      const details = await desktop.getOpenClashDetails();
      if (details.groups.length > 0) {
        const primary = details.groups[0];
        if (primary) {
          setNodes(primary.nodes);
          setCurrentGroup(primary.name);
        }
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[ExpandedRoot] getOpenClashDetails failed:', err);
    }
  }, []);

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
      if (!cancelled) setDashboard(d);
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

  const networkBadges = useMemo(() => {
    if (!dashboard) return [];
    const apiOk = dashboard.openclash.apiOk;
    return [
      { label: '路由', tone: dashboard.router.ok ? 'ok' : 'bad' as const },
      { label: 'Clash TCP', tone: dashboard.openclash.tcpOk ? 'ok' : 'bad' as const },
      {
        label: 'API',
        tone: apiOk === true ? 'ok' : apiOk === 'auth_error' ? 'warn' : 'bad' as const,
      },
    ];
  }, [dashboard]);

  return (
    <div className="ex" data-testid="expanded-root">
      {/* ── Topbar ────────────────────────────────────────────── */}
      <header className="ex__topbar">
        <div className="ex__brand">
          <span className="ex__brand-mark" aria-hidden="true">◆</span>
          <span className="ex__brand-name">MONITOR</span>
          <span className="ex__brand-tag">network · ai watch</span>
        </div>

        <nav className="ex__tabs" role="tablist" aria-label="主导航">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`ex__tab${active ? ' ex__tab--active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="ex__tab-icon" aria-hidden="true">{t.icon}</span>
                <span className="ex__tab-label">{t.label}</span>
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          className={`ex__refresh${refreshing ? ' ex__refresh--spin' : ''}`}
          onClick={() => void handleRefresh()}
          aria-label="立即刷新"
          title="立即刷新"
          disabled={refreshing}
        >
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      </header>

      {/* ── Tab content ───────────────────────────────────────── */}
      <main className="ex__main" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {error && (
          <div className="ex__error" role="alert">
            <span className="ex__error-mark" aria-hidden="true">!</span>
            <span>{error}</span>
          </div>
        )}

        {tab === 'network' && (
          <div className="ex__stack">
            {/* Network glance — moved from the global header so it
                lives with the rest of the network tab. */}
            <article className="ex__card ex__card--network" aria-label="网络状态">
              <header className="ex__card-head">
                <span className="ex__card-eyebrow">network</span>
                <span className="ex__card-title">连通性</span>
              </header>

              {dashboard ? (
                <>
                  <div className="ex__hero">
                    <StatusHero state={dashboard} />
                  </div>

                  <div className="ex__node-line" title={dashboard.currentNode.node ?? ''}>
                    {dashboard.currentNode.group && (
                      <span className="ex__node-group">{dashboard.currentNode.group}</span>
                    )}
                    <span className="ex__node-name">
                      {dashboard.currentNode.node ?? '等待节点数据'}
                    </span>
                  </div>

                  <div className="ex__trend" aria-hidden="true">
                    <Sparkline
                      data={dashboard.currentNode.sparkline}
                      width={920}
                      height={72}
                      strokeWidth={1.5}
                      fill
                    />
                  </div>

                  <ul className="ex__badges">
                    {networkBadges.map((b) => (
                      <li key={b.label} className={`ex__badge ex__badge--${b.tone}`}>
                        <span className="ex__badge-dot" />
                        <span className="ex__badge-label">{b.label}</span>
                      </li>
                    ))}
                    {dashboard.currentNode.avgLatencyMs !== null && (
                      <li className="ex__badge ex__badge--neutral ex__badge--metric">
                        <span className="ex__badge-label">avg</span>
                        <span className="ex__badge-value">
                          {formatLatency(dashboard.currentNode.avgLatencyMs)}
                        </span>
                      </li>
                    )}
                  </ul>
                </>
              ) : (
                <div className="ex__placeholder">等待数据中…</div>
              )}
            </article>

            {/* Quick actions — Quick Node Card + Config Switch Card.
                Only mounted on the expanded window's Network tab
                (Requirement 1: compact window stays untouched). */}
            <QuickActionsPanel healthStatus={dashboard?.status ?? 'healthy'} />

            {/* Node table */}
            <section className="ex__panel ex__panel--network" aria-label="节点列表">
              <header className="ex__panel-head">
                <h2 className="ex__panel-title">
                  节点
                  <span className="ex__panel-count">{nodes.length}</span>
                </h2>
                {currentGroup && (
                  <span className="ex__panel-meta">
                    分组 <strong>{currentGroup}</strong>
                  </span>
                )}
              </header>

              <NodeTable
                nodes={nodes}
                currentNode={dashboard?.currentNode.node ?? null}
                groupName={currentGroup ?? dashboard?.currentNode.group ?? null}
                switchConfirmEnabled={switchConfirm}
              />
            </section>
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
