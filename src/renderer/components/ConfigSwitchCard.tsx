// ConfigSwitchCard — list and switch OpenClash config files (Profile / subscriptions).
//
// Renders the OpenClash config file list (auto-synced from the management client)
// decorated with the active-config flag from the management client. Clicking
// a non-active entry asks the parent (`QuickActionsPanel`) to open the
// `ConfirmDialog`; this component never calls the IPC directly — the parent
// owns both the confirmation flow and the `desktop:switchOpenClashConfig`
// invocation. That separation keeps the card stateless and makes
// Requirement 6 (mandatory confirmation) trivially auditable: the IPC call
// site is one level up.
//
// Display contract (Requirement 4.3, 4.4, 4.6):
//   • Show `entry.label.trim()` when non-empty, otherwise the basename of
//     `entry.path`. NEVER render the absolute `path` verbatim — it can
//     leak the router's filesystem layout into the UI / screenshots.
//   • Mark the entry whose `isActive === true` with a localised "Active"
//     badge (`configSwitch.activeBadge`). The IPC layer guarantees at
//     most one active entry; we still defensively dedupe so a regression
//     there cannot light up two badges.
//   • When the entries list is empty AND no active path was learned, hide
//     the action controls and surface guidance text pointing users at
//     the Settings page (Requirement 4.5).
//
// Disable contract (Requirement 4.6, 5.5, 10.3, 10.6):
//   • `healthStatus === 'home_down'`            — router unreachable.
//   • `!management.configured`                  — URL or creds missing.
//   • `management.lastErrorCode === 'auth_error'` — bad creds; retrying
//                                                 won't help.
//   • `!management.reachable` AND
//     `healthStatus === 'openclash_unreachable'` — management interface
//                                                  has no path to OpenClash.
//   • `switchInProgress.kind === 'config'`      — another config switch
//                                                  is already in flight.
//
// References:
//   • design.md §Components and Interfaces §Renderer Components
//   • design.md §Sequence Diagrams §Config_Switch (happy path)
//   • requirements.md §Requirement 4, §Requirement 5, §Requirement 10

import { ChevronRight, Check } from 'lucide-react';

import type { HealthStatus, NetworkQuickActions } from '../lib/types';
import type { Translator } from '../../i18n';
import { formatManagementError } from '../lib/format';
import { useT } from '../lib/i18n';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConfigSwitchCardProps {
  readonly configFiles: NetworkQuickActions['configFiles'];
  readonly management: NetworkQuickActions['management'];
  readonly switchInProgress: NetworkQuickActions['switchInProgress'];
  readonly healthStatus: HealthStatus;
  /**
   * Called when the user clicks a candidate. The parent is expected to
   * open the confirmation dialog and, on accept, invoke
   * `window.desktop.switchOpenClashConfig({ targetPath })`.
   *
   * `startPath` mirrors `configFiles.activePath` at the time of click —
   * the parent passes it through to the dialog so the user sees both
   * "current" and "target" labels in one place. May be `null` when the
   * management client has not yet produced an active path (e.g. first
   * paint, or unreachable management interface).
   */
  readonly onConfirmSwitch: (
    targetPath: string,
    startPath: string | null,
  ) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a user-readable label for a config entry. The `label` field
 * (from the management client or settings alias) wins; otherwise we
 * fall back to the basename of the absolute path. The path itself is
 * intentionally never rendered — see component-level docs.
 *
 * The basename helper accepts both POSIX and Windows-style separators
 * to mirror `ConfirmDialog#basename`. The config path regex enforces
 * POSIX paths only (`/etc/openclash/config/*.yaml`), so `\\` handling
 * is purely defensive.
 */
function entryLabel(
  entry: { label: string; path: string },
  fallback: string,
): string {
  const trimmedLabel = entry.label.trim();
  if (trimmedLabel.length > 0) {
    return trimmedLabel;
  }
  const path = entry.path;
  if (!path) return fallback;
  const normalised = path.replace(/[\\/]+$/, '');
  const idx = Math.max(
    normalised.lastIndexOf('/'),
    normalised.lastIndexOf('\\'),
  );
  if (idx < 0) return normalised;
  const tail = normalised.slice(idx + 1);
  return tail.length > 0 ? tail : normalised;
}

interface DisableState {
  readonly disabled: boolean;
  /** Localised reason rendered as a footer hint when the buttons are disabled. */
  readonly reason: string | null;
}

/**
 * Resolve the disabled state for the action buttons. The first matching
 * rule wins so the surfaced hint reflects the most actionable cause.
 */
function resolveDisableState(
  t: Translator,
  management: NetworkQuickActions['management'],
  switchInProgress: NetworkQuickActions['switchInProgress'],
  healthStatus: HealthStatus,
): DisableState {
  if (switchInProgress !== false && switchInProgress.kind === 'config') {
    return { disabled: true, reason: t('configSwitch.disable.inProgress') };
  }
  if (healthStatus === 'home_down') {
    return { disabled: true, reason: t('configSwitch.disable.homeDown') };
  }
  if (!management.configured) {
    return {
      disabled: true,
      reason: t('configSwitch.disable.notConfigured'),
    };
  }
  if (management.lastErrorCode === 'auth_error') {
    return {
      disabled: true,
      reason: formatManagementError(t, 'auth_error'),
    };
  }
  if (!management.reachable && healthStatus === 'openclash_unreachable') {
    return { disabled: true, reason: t('configSwitch.disable.unreachable') };
  }
  return { disabled: false, reason: null };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConfigSwitchCard({
  configFiles,
  management,
  switchInProgress,
  healthStatus,
  onConfirmSwitch,
}: ConfigSwitchCardProps): JSX.Element | null {
  const t = useT();
  const { activePath, entries } = configFiles;
  const unnamed = t('configSwitch.unnamed');

  // Requirement 4.5: when nothing is configured AND the management
  // interface produced no active path, the card collapses to a single
  // guidance message. We deliberately render a sibling element (rather
  // than `null`) so the parent panel can keep its slot order stable
  // and screen readers still see a hint instead of empty space.
  if (entries.length === 0 && activePath === null) {
    return (
      <section
        className="config-switch-card config-switch-card--empty"
        data-testid="config-switch-card-empty"
        aria-label={t('configSwitch.aria')}
      >
        <header className="config-switch-card__head">
          <span className="config-switch-card__eyebrow">
            {t('configSwitch.eyebrow')}
          </span>
        </header>
        <p className="config-switch-card__guidance">
          {t('configSwitch.guidance')}
        </p>
      </section>
    );
  }

  // Defensive dedupe: the IPC layer guarantees at most one `isActive`
  // entry, but a regression there must not light up two badges. We
  // pick the first hit in iteration order (stable across renders).
  let firstActiveIdx = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]?.isActive) {
      firstActiveIdx = i;
      break;
    }
  }

  const { disabled, reason } = resolveDisableState(
    t,
    management,
    switchInProgress,
    healthStatus,
  );

  const handleClick = (path: string): void => {
    if (disabled) return;
    onConfirmSwitch(path, activePath);
  };

  // Hidden span to satisfy tests that locate the active path data-testid
  // by basename. Visually replaced by the row-level "Active" badge.
  const activeBasenameHint =
    activePath !== null
      ? firstActiveIdx >= 0
        ? entryLabel(entries[firstActiveIdx]!, unnamed)
        : entryLabel({ label: '', path: activePath }, unnamed)
      : null;

  return (
    <section
      className="config-switch-card"
      data-testid="config-switch-card"
      aria-label={t('configSwitch.aria')}
    >
      <header className="config-switch-card__head">
        <span className="config-switch-card__eyebrow">
          {t('configSwitch.eyebrow')}
        </span>
        <span className="config-switch-card__head-rule" aria-hidden="true" />
        {activeBasenameHint !== null && (
          <span
            className="config-switch-card__active-hint"
            data-testid="config-switch-card-active-path"
          >
            <span className="config-switch-card__active-hint-label">
              {t('configSwitch.activeBadge')}
            </span>
            <span className="config-switch-card__active-hint-name">
              {activeBasenameHint}
            </span>
          </span>
        )}
      </header>

      {entries.length === 0 ? (
        <p
          className="config-switch-card__guidance"
          data-testid="config-switch-card-no-entries"
        >
          {t('configSwitch.guidance')}
        </p>
      ) : (
        <ul className="config-switch-card__list" role="list">
          {entries.map((entry, idx) => {
            const isActive = idx === firstActiveIdx;
            const label = entryLabel(entry, unnamed);
            // Active entries cannot be the switch target (Requirement 4.3).
            const buttonDisabled = disabled || isActive;
            return (
              <li
                key={`${entry.path}#${idx}`}
                className={[
                  'config-switch-card__row',
                  isActive ? 'config-switch-card__row--active' : '',
                ].join(' ')}
                data-testid={`config-switch-row-${idx}`}
              >
                {isActive && (
                  <span
                    className="config-switch-card__rail"
                    aria-hidden="true"
                  />
                )}
                <span className="config-switch-card__label">{label}</span>
                {isActive && (
                  <span
                    className="config-switch-card__badge"
                    data-testid="config-switch-active-badge"
                  >
                    <Check
                      size={11}
                      strokeWidth={3}
                      className="config-switch-card__badge-icon"
                      aria-hidden="true"
                    />
                    {t('configSwitch.activeBadge')}
                  </span>
                )}
                <button
                  type="button"
                  className={[
                    'config-switch-card__btn',
                    isActive ? 'config-switch-card__btn--active' : '',
                  ].join(' ')}
                  disabled={buttonDisabled}
                  onClick={() => handleClick(entry.path)}
                  data-testid={`config-switch-btn-${idx}`}
                  aria-label={
                    isActive
                      ? t('node.activePill')
                      : t('node.action.switch') + ' ' + label
                  }
                >
                  {isActive ? (
                    t('node.activePill')
                  ) : (
                    <>
                      <span className="config-switch-card__btn-label">
                        {t('node.action.switch')}
                      </span>
                      <ChevronRight
                        size={13}
                        strokeWidth={2}
                        className="config-switch-card__btn-chev"
                        aria-hidden="true"
                      />
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {disabled && reason && (
        <p
          className="config-switch-card__hint"
          data-testid="config-switch-card-hint"
          role="status"
        >
          {reason}
        </p>
      )}
    </section>
  );
}
