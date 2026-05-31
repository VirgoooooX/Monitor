// QuickActionsPanel — top-level container for the expanded window's
// "Quick actions" surface (network-quick-actions task 15.2).
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { ConfigSwitchCard } from './ConfigSwitchCard';
import { ConfirmDialog } from './ConfirmDialog';
import { formatManagementError } from '../lib/format';
import { useT } from '../lib/i18n';
import type { Translator } from '../../i18n';
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
 * always visible, kept compact so the banner stays a single row
 * even on the narrowest expanded layout) and an optional `detail`
 * (full sentence with the actionable suggestion, surfaced in the
 * native `title` tooltip on hover). The selector helper below
 * builds both halves from the active-locale catalog so the
 * renderer never has to know whether a particular state has a
 * separate detail line.
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
 *
 * Every visible string comes from the active-locale catalog via
 * the supplied `Translator`, so banners flip live with the rest of
 * the UI when the user changes language (Requirement 4.1, 7.1).
 */
function selectBanner(
  t: Translator,
  health: HealthStatus,
  management: NetworkQuickActions['management'] | null,
): BannerSpec | null {
  if (health === 'home_down') {
    return {
      tone: 'critical',
      headline: t('quickActions.banner.homeDown.headline'),
      detail: t('quickActions.banner.homeDown.detail'),
    };
  }

  if (management !== null && management.consecutiveFailures >= 5) {
    return {
      tone: 'warn',
      headline: t('quickActions.banner.managementFailures.headline'),
      detail: t('quickActions.banner.managementFailures.detail'),
    };
  }

  if (health === 'openclash_unreachable') {
    if (management !== null && !management.reachable) {
      return {
        tone: 'warn',
        headline: t('quickActions.banner.managementUnreachable.headline'),
        detail: t('quickActions.banner.managementUnreachable.detail'),
      };
    }
    return {
      tone: 'notice',
      headline: t('quickActions.banner.kernelUnreachable.headline'),
      detail: t('quickActions.banner.kernelUnreachable.detail'),
    };
  }

  if (management !== null && management.lastErrorCode === 'auth_error') {
    return {
      tone: 'warn',
      headline: t('quickActions.banner.credsError.headline'),
      detail: formatManagementError(t, 'auth_error'),
    };
  }

  if (
    health === 'node_slow' ||
    health === 'partial_outage' ||
    health === 'node_down'
  ) {
    return {
      tone: 'notice',
      headline: t('quickActions.banner.networkDegraded.headline'),
      detail: t('quickActions.banner.networkDegraded.detail'),
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
function Banner({
  spec,
  t,
}: {
  readonly spec: BannerSpec;
  readonly t: Translator;
}): JSX.Element {
  const Icon = BANNER_ICON[spec.tone];
  const ariaLabel =
    spec.detail !== undefined && spec.detail.length > 0
      ? t('quickActions.banner.ariaTemplate', {
          headline: spec.headline,
          detail: spec.detail,
        })
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
  const t = useT();
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
          setSwitchError(formatManagementError(t, result.error.code));
        } else {
          setSwitchError(null);
        }
      }
    } catch (err: unknown) {
      if (!cancelledRef.current) {
        const message =
          err instanceof Error ? err.message : t('quickActions.switchUnknownError');
        setSwitchError(message);
      }
    } finally {
      // Always refetch so the panel reflects the post-switch state
      // (success or failure both update `lastConfigSwitch` and the
      // active path readback).
      void refresh();
    }
  }, [confirmDialog, closeDialog, refresh, t]);

  const handleDialogCancel = useCallback(() => {
    // Cancel writes nothing (Requirement 6.4).
    closeDialog();
  }, [closeDialog]);

  // ─── Banner selection ───────────────────────────────────────────────
  const banner = useMemo(
    () => selectBanner(t, healthStatus, data?.management ?? null),
    [t, healthStatus, data?.management],
  );

  // ─── Render ─────────────────────────────────────────────────────────
  if (bridgeMissing) {
    return (
      <section
        className="quick-actions-panel quick-actions-panel--bridge-missing"
        data-testid="quick-actions-panel"
        data-state="bridge-missing"
        aria-label={t('quickActions.aria')}
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
        aria-label={t('quickActions.aria')}
        aria-busy="true"
      >
        {banner && <Banner spec={banner} t={t} />}
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
      aria-label={t('quickActions.aria')}
    >
      {banner && <Banner spec={banner} t={t} />}

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
            {t('quickActions.lastConfigSwitchPrefix')}
            {formatManagementError(t, data.lastConfigSwitch.resultCode)}
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
