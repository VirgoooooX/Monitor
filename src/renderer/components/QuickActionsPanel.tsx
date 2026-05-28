// QuickActionsPanel — top-level container for the expanded window's
// "快捷动作" surface (network-quick-actions task 15.2).
//
// Composition (top → bottom, fixed in sibling order per Requirement 2.3):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  Banner   (degraded / persistent-failure / auth, conditional)│
//   ├──────────────────────────────────────────────────────────────┤
//   │  QuickNodeCard       (primary group + ranked candidates)     │
//   ├──────────────────────────────────────────────────────────────┤
//   │  ConfigSwitchCard    (whitelist + active marker)             │
//   └──────────────────────────────────────────────────────────────┘
//   Plus a single-instance ConfirmDialog (modal, only when open).
//
// Data lifecycle:
//   • On mount, render skeleton placeholders immediately so the
//     panel is visible within the 1000 ms budget of Requirement 2.2,
//     even before the first `getNetworkQuickActions` resolves.
//   • Issue `window.desktop.getNetworkQuickActions()` once; subscribe
//     to `'dashboard.updated'` and `'openclash.updated'` push events
//     to refetch on every state change (Requirement 2.1, 2.2).
//   • On unmount, cancel both subscriptions to avoid `setState`
//     after teardown.
//
// Banner selection (Requirements 2.5, 10.2..10.6, 14.4, 12.3, 4.6):
//   The first matching rule wins, ordered by user actionability:
//     1.  home_down                                       — red, fatal
//     2.  management.consecutiveFailures >= 5              — orange, persistent
//     3.  openclash_unreachable + !management.reachable    — orange, unreachable
//     4.  openclash_unreachable + management.reachable     — yellow, switch may help
//     5.  management.lastErrorCode === 'auth_error'        — orange, fix creds
//     6.  node_slow | partial_outage | node_down           — yellow, degraded
//   On `healthy` with no management failure, no banner is rendered
//   (Requirement 2.4 + 10.7).
//
// IPC / dialog wiring:
//   • ConfigSwitchCard's `onConfirmSwitch(targetPath, startPath)`
//     opens the dialog. The dialog never calls IPC directly.
//   • `onConfirm` invokes `desktop.switchOpenClashConfig({ targetPath })`
//     and closes the dialog. We refetch quick actions on completion
//     so the UI mirrors the new active path.
//   • `onCancel` closes the dialog without writing anything
//     (Requirement 6.4).
//
// Last-switch failure hint (Requirement 8.5):
//   The `lastConfigSwitch` slice carries the most recent end-row from
//   `openclash_config_changes`. When its `resultCode` is anything
//   other than `'ok'` we surface a small status row below the
//   ConfigSwitchCard, formatted via the canonical i18n map so wording
//   stays in lock-step with banners and inline errors. `ok` results
//   are suppressed to avoid distracting users during normal operation.
//
// Network tab integration (task 17.1) inserts this component between
// `StatusHero` and `NodeTable`. This file deliberately does not
// touch `App.tsx`.
//
// References:
//   • network-quick-actions/design.md §IPC Surface, §Renderer Components
//   • network-quick-actions/requirements.md §Requirement 2, 10, 14

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { ConfigSwitchCard } from './ConfigSwitchCard';
import { ConfirmDialog } from './ConfirmDialog';
import { formatManagementError } from '../lib/format';
import type {
  HealthStatus,
  NetworkQuickActions,
  Unsubscribe,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QuickActionsPanelProps {
  /**
   * Current health status for banner / disable decisions. The parent
   * (`App.tsx` Network tab) sources this from the dashboard push
   * stream so banners flip in lock-step with the rest of the UI.
   */
  readonly healthStatus: HealthStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BannerTone = 'critical' | 'warn' | 'notice';

/**
 * Banner copy is split into a short `headline` (renders inline,
 * always visible, kept to ≤ ~12 CJK glyphs so the banner stays a
 * single compact row even on the narrowest expanded layout) and an
 * optional `detail` (full sentence with the actionable suggestion,
 * surfaced in the native `title` tooltip on hover). The selector
 * helper below builds both halves so the renderer never has to know
 * whether a particular state has a separate detail line.
 */
interface BannerSpec {
  readonly tone: BannerTone;
  readonly headline: string;
  readonly detail?: string;
}

/**
 * Decide which banner — if any — to show at the top of the panel.
 *
 * The order below is the priority order: `home_down` is fatal
 * (the router itself is gone, no switch can succeed), persistent
 * management failure is the next most actionable signal (the user
 * almost certainly needs to check creds or network), unreachable
 * management interferes with config switch only, auth_error
 * applies to the whole panel, and the generic degraded banner is
 * the catch-all for `node_slow / partial_outage / node_down`.
 */
function selectBanner(
  health: HealthStatus,
  management: NetworkQuickActions['management'] | null,
): BannerSpec | null {
  if (health === 'home_down') {
    return {
      tone: 'critical',
      headline: '家庭离线',
      detail: '路由器不可达，所有切换都会失败；请检查家中网络与路由器电源',
    };
  }

  if (management !== null && management.consecutiveFailures >= 5) {
    return {
      tone: 'warn',
      headline: '管理接口持续失败',
      detail: 'OpenClash 管理接口已连续失败 5 次以上，请检查凭据或网络',
    };
  }

  if (health === 'openclash_unreachable') {
    if (management !== null && !management.reachable) {
      return {
        tone: 'warn',
        headline: '管理接口不可达',
        detail: 'OpenClash 管理接口暂时无法连接；切换操作将不可用',
      };
    }
    return {
      tone: 'notice',
      headline: '内核暂不可达',
      detail: 'OpenClash 内核暂时无响应，可尝试切换配置以恢复',
    };
  }

  if (management !== null && management.lastErrorCode === 'auth_error') {
    return {
      tone: 'warn',
      headline: '凭据错误',
      detail: formatManagementError('auth_error'),
    };
  }

  if (
    health === 'node_slow' ||
    health === 'partial_outage' ||
    health === 'node_down'
  ) {
    return {
      tone: 'notice',
      headline: '网络降级',
      detail: '当前节点出现降级，建议切换节点或配置',
    };
  }

  return null;
}

/**
 * Tone → icon mapping. Matches the colour semantics already encoded
 * in `--banner--{tone}` css classes: `critical` is the loudest
 * (system-down), `warn` is "investigate now", `notice` is "FYI". We
 * use the same three Lucide glyphs every screen in the app uses for
 * these tones so the visual vocabulary stays consistent.
 */
const BANNER_ICON: Record<BannerTone, typeof AlertCircle> = {
  critical: AlertCircle,
  warn: AlertTriangle,
  notice: Info,
};

/**
 * Compact banner row: icon + short headline. The full sentence
 * (`spec.detail`) lives on the native `title` tooltip so users who
 * want the actionable copy can hover, and screen readers still get
 * it via `aria-label`. Renders as a single line; the underlying
 * `.quick-actions-panel__banner` style supplies the chip-like chrome.
 */
function Banner({ spec }: { readonly spec: BannerSpec }): JSX.Element {
  const Icon = BANNER_ICON[spec.tone];
  const ariaLabel =
    spec.detail !== undefined && spec.detail.length > 0
      ? `${spec.headline}：${spec.detail}`
      : spec.headline;
  return (
    <div
      className={`quick-actions-panel__banner quick-actions-panel__banner--${spec.tone}`}
      role="status"
      data-testid="quick-actions-panel-banner"
      data-tone={spec.tone}
      title={spec.detail}
      aria-label={ariaLabel}
    >
      <Icon
        size={14}
        strokeWidth={2.25}
        className="quick-actions-panel__banner-icon"
        aria-hidden="true"
      />
      <span className="quick-actions-panel__banner-text">{spec.headline}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuickActionsPanel({
  healthStatus,
}: QuickActionsPanelProps): JSX.Element {
  const [data, setData] = useState<NetworkQuickActions | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState<boolean>(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    readonly open: boolean;
    readonly targetPath: string;
    readonly startPath: string | null;
  }>({ open: false, targetPath: '', startPath: null });
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Track whether the component is still mounted so an in-flight
  // promise resolution does not call `setState` on a torn-down tree.
  const cancelledRef = useRef<boolean>(false);

  const refresh = useCallback(async (): Promise<void> => {
    const desktop = window.desktop;
    if (!desktop) return;
    try {
      const next = await desktop.getNetworkQuickActions();
      if (!cancelledRef.current) {
        setData(next);
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- diagnostic only
      console.error('[QuickActionsPanel] getNetworkQuickActions failed:', err);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    const desktop = window.desktop;
    if (!desktop) {
      setBridgeMissing(true);
      return;
    }

    void refresh();

    const unsubDashboard: Unsubscribe = desktop.on('dashboard.updated', () => {
      void refresh();
    });
    const unsubOpenClash: Unsubscribe = desktop.on('openclash.updated', () => {
      void refresh();
    });

    return () => {
      cancelledRef.current = true;
      unsubDashboard();
      unsubOpenClash();
    };
  }, [refresh]);

  // ─── Confirm dialog wiring ──────────────────────────────────────────
  const handleConfirmSwitch = useCallback(
    (targetPath: string, startPath: string | null) => {
      setSwitchError(null);
      setConfirmDialog({ open: true, targetPath, startPath });
    },
    [],
  );

  const closeDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, open: false }));
  }, []);

  const handleDialogConfirm = useCallback(async (): Promise<void> => {
    const desktop = window.desktop;
    const { targetPath } = confirmDialog;
    closeDialog();
    if (!desktop || !targetPath) return;

    try {
      const result = await desktop.switchOpenClashConfig({ targetPath });
      if (!cancelledRef.current) {
        if (!result.ok && result.error) {
          setSwitchError(formatManagementError(result.error.code));
        } else {
          setSwitchError(null);
        }
      }
    } catch (err: unknown) {
      if (!cancelledRef.current) {
        const message =
          err instanceof Error ? err.message : '切换配置时发生未知错误';
        setSwitchError(message);
      }
    } finally {
      // Always refetch so the panel reflects the post-switch state
      // (success or failure both update `lastConfigSwitch` and the
      // active path readback).
      void refresh();
    }
  }, [confirmDialog, closeDialog, refresh]);

  const handleDialogCancel = useCallback(() => {
    // Cancel writes nothing (Requirement 6.4).
    closeDialog();
  }, [closeDialog]);

  // ─── Banner selection ───────────────────────────────────────────────
  const banner = selectBanner(healthStatus, data?.management ?? null);

  // ─── Render ─────────────────────────────────────────────────────────
  if (bridgeMissing) {
    return (
      <section
        className="quick-actions-panel quick-actions-panel--bridge-missing"
        data-testid="quick-actions-panel"
        data-state="bridge-missing"
        aria-label="快捷动作"
      >
        <p className="quick-actions-panel__hint" role="alert">
          preload bridge unavailable
        </p>
      </section>
    );
  }

  // Skeleton view: rendered immediately on mount before the first
  // `getNetworkQuickActions` resolves. Sibling order matches the
  // loaded view so the layout does not jump on hydration
  // (Requirement 2.2 + 2.3).
  if (data === null) {
    return (
      <section
        className="quick-actions-panel quick-actions-panel--loading"
        data-testid="quick-actions-panel"
        data-state="loading"
        aria-label="快捷动作"
        aria-busy="true"
      >
        {banner && <Banner spec={banner} />}
        <div
          className="quick-actions-panel__skeleton quick-actions-panel__skeleton--config"
          data-testid="quick-actions-panel-skeleton-config"
          aria-hidden="true"
        />
      </section>
    );
  }

  const degraded =
    healthStatus !== 'healthy' ||
    (data.management.consecutiveFailures >= 5);

  return (
    <section
      className={[
        'quick-actions-panel',
        degraded ? 'quick-actions-panel--degraded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="quick-actions-panel"
      data-state="ready"
      data-health={healthStatus}
      data-degraded={degraded ? 'true' : 'false'}
      aria-label="快捷动作"
    >
      {banner && <Banner spec={banner} />}

      {switchError && (
        <div
          className="quick-actions-panel__error"
          role="alert"
          data-testid="quick-actions-panel-error"
          onClick={() => setSwitchError(null)}
        >
          {switchError}
        </div>
      )}

      {/* QuickNodeCard removed — node switching is handled by the
          NodeTable section below the panel, which already lists every
          node with status indicators. Keeping the duplicate
          quick-switch chip on top wasted vertical space and gave
          users two click paths for the same operation. */}

      <ConfigSwitchCard
        configFiles={data.configFiles}
        management={data.management}
        switchInProgress={data.switchInProgress}
        healthStatus={healthStatus}
        onConfirmSwitch={handleConfirmSwitch}
      />

      {/*
        Persisted "last config switch failure" hint (Requirement 8.5).
        The inline `switchError` above shows the result of the most
        recent in-session attempt; this row reads the audit log via
        `lastConfigSwitch` so a failure persists across panel
        remounts and dashboard refreshes. Suppressed on `ok` results
        to avoid distracting users when the previous switch succeeded.
      */}
      {data.lastConfigSwitch !== null &&
        data.lastConfigSwitch.resultCode !== 'ok' && (
          <p
            className="quick-actions-panel__last-switch"
            data-testid="quick-actions-panel-last-switch"
            role="status"
          >
            上次配置切换：
            {formatManagementError(data.lastConfigSwitch.resultCode)}
          </p>
        )}

      <ConfirmDialog
        open={confirmDialog.open}
        startPath={confirmDialog.startPath}
        targetPath={confirmDialog.targetPath}
        onConfirm={() => void handleDialogConfirm()}
        onCancel={handleDialogCancel}
      />
    </section>
  );
}
