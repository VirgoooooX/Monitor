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

import { useCallback, useEffect, useState } from 'react';

import { WidgetShell } from './components/WidgetShell';
import { NodeTable } from './components/NodeTable';
import { UsagePanel } from './components/UsagePanel';
import { SettingsView } from './components/SettingsView';
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
      body.classList.add('expanded');
      body.classList.remove('compact');
    } else {
      body.classList.add('compact');
      body.classList.remove('expanded');
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
// Expanded root — tabbed layout with Network and Usage panels.
// ---------------------------------------------------------------------------

type ExpandedTab = 'network' | 'usage' | 'settings';

function ExpandedRoot(): JSX.Element {
  const [tab, setTab] = useState<ExpandedTab>('network');
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [currentGroup, setCurrentGroup] = useState<string | null>(null);
  const [switchConfirm, setSwitchConfirm] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      setError('preload bridge unavailable');
      return;
    }

    let cancelled = false;

    // Load initial dashboard
    desktop.getDashboard().then((d) => {
      if (!cancelled) setDashboard(d);
    }).catch((err: unknown) => {
      if (!cancelled) setError(`getDashboard: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Load settings for switchConfirmation
    desktop.getSettings().then((s) => {
      if (!cancelled) setSwitchConfirm(s.switchConfirmation);
    }).catch(() => { /* non-fatal */ });

    // Load node details
    desktop.getOpenClashDetails().then((details) => {
      if (!cancelled && details.groups.length > 0) {
        const primary = details.groups[0];
        if (primary) {
          setNodes(primary.nodes);
          setCurrentGroup(primary.name);
        }
      }
    }).catch((err: unknown) => {
      // Non-fatal: node table will just be empty
      console.error('[ExpandedRoot] getOpenClashDetails failed:', err);
    });

    // Subscribe to live updates
    const unsub = desktop.on('dashboard.updated', (d) => {
      if (!cancelled) setDashboard(d);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return (
    <div className="expanded" data-testid="expanded-root">
      {/* Sidebar navigation */}
      <nav className="expanded__nav" aria-label="主导航">
        <div className="expanded__brand">Monitor</div>
        <button
          className={`expanded__tab${tab === 'network' ? ' expanded__tab--active' : ''}`}
          onClick={() => setTab('network')}
          type="button"
          aria-selected={tab === 'network'}
        >
          🌐 网络
        </button>
        <button
          className={`expanded__tab${tab === 'usage' ? ' expanded__tab--active' : ''}`}
          onClick={() => setTab('usage')}
          type="button"
          aria-selected={tab === 'usage'}
        >
          📊 AI 用量
        </button>
        <button
          className={`expanded__tab${tab === 'settings' ? ' expanded__tab--active' : ''}`}
          onClick={() => setTab('settings')}
          type="button"
          aria-selected={tab === 'settings'}
        >
          ⚙️ 设置
        </button>
      </nav>

      {/* Main content */}
      <main className="expanded__main">
        {error && (
          <div style={{ padding: '12px 16px', background: 'rgba(239,68,68,0.15)', borderRadius: '6px', marginBottom: '16px', color: '#f87171', fontSize: '13px' }}>
            ⚠️ {error}
          </div>
        )}

        <div style={{ padding: '8px', color: '#888', fontSize: '12px' }}>
          bridge: {typeof window !== 'undefined' && window.desktop ? '✅' : '❌'} |
          dashboard: {dashboard ? '✅' : '⏳'} |
          nodes: {nodes.length}
        </div>

        {tab === 'network' && (
          <div className="expanded__panel">
            {/* Status summary card */}
            {dashboard ? (
              <div className="expanded__status-card">
                <div className="expanded__status-row">
                  <span className={`expanded__dot expanded__dot--${dashboard.status === 'healthy' ? 'ok' : 'bad'}`} />
                  <span className="expanded__status-label">{dashboard.statusLabel}</span>
                </div>
                <div className="expanded__meta-row">
                  <span>路由: {dashboard.router.ok ? '✅' : '❌'}</span>
                  <span>Clash TCP: {dashboard.openclash.tcpOk ? '✅' : '❌'}</span>
                  <span>API: {dashboard.openclash.apiOk === true ? '✅' : '❌'}</span>
                  {dashboard.currentNode.avgLatencyMs !== null && (
                    <span>延迟: {Math.round(dashboard.currentNode.avgLatencyMs)}ms</span>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ padding: '16px', color: '#999', fontSize: '13px' }}>
                等待数据中…
              </div>
            )}

            {/* Node table */}
            <h3 className="expanded__section-title">节点列表</h3>
            <NodeTable
              nodes={nodes}
              currentNode={dashboard?.currentNode.node ?? null}
              groupName={currentGroup ?? dashboard?.currentNode.group ?? null}
              switchConfirmEnabled={switchConfirm}
            />
          </div>
        )}

        {tab === 'usage' && (
          <div className="expanded__panel">
            <UsagePanel />
          </div>
        )}

        {tab === 'settings' && (
          <div className="expanded__panel">
            <SettingsView />
          </div>
        )}
      </main>
    </div>
  );
}
