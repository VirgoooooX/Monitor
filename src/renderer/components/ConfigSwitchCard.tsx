// ConfigSwitchCard — list and switch OpenClash config files (Profile / 订阅).
//
// Renders the user-curated whitelist (`managementInterface.configFileWhitelist`)
// decorated with the active-config flag from the management client. Clicking
// a non-active entry asks the parent (`QuickActionsPanel`) to open the
// `ConfirmDialog`; this component never calls the IPC directly — the parent
// owns both the confirmation flow and the `desktop:switchOpenClashConfig`
// invocation. That separation keeps the card stateless and makes
// Requirement 6 (mandatory confirmation) trivially auditable: the IPC call
// site is one level up.
//
// Display contract (Requirement 4.3, 4.4, 4.6):
//   • Show `entry.alias.trim()` when non-empty, otherwise the basename of
//     `entry.path`. NEVER render the absolute `path` verbatim — it can
//     leak the router's filesystem layout into the UI / screenshots.
//   • Mark the entry whose `isActive === true` with a "生效" badge. The
//     IPC layer guarantees at most one active entry; we still defensively
//     dedupe so a regression there cannot light up two badges.
//   • When the whitelist is empty AND no active path was learned, hide
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
import { formatManagementError } from '../lib/format';

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
 * Derive a user-readable label for a whitelist entry. Trimmed alias wins;
 * otherwise we fall back to the basename of the absolute path. The path
 * itself is intentionally never rendered — see component-level docs.
 *
 * The basename helper accepts both POSIX and Windows-style separators
 * to mirror `ConfirmDialog#basename`. The whitelist regex enforces
 * POSIX paths only (`/etc/openclash/config/*.yaml`), so `\\` handling
 * is purely defensive.
 */
function entryLabel(entry: { alias: string; path: string }): string {
  const trimmedAlias = entry.alias.trim();
  if (trimmedAlias.length > 0) {
    return trimmedAlias;
  }
  const path = entry.path;
  if (!path) return '(未命名配置)';
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
  /** zh-CN reason rendered as a footer hint when the buttons are disabled. */
  readonly reason: string | null;
}

/**
 * Resolve the disabled state for the action buttons. The first matching
 * rule wins so the surfaced hint reflects the most actionable cause.
 */
function resolveDisableState(
  management: NetworkQuickActions['management'],
  switchInProgress: NetworkQuickActions['switchInProgress'],
  healthStatus: HealthStatus,
): DisableState {
  if (switchInProgress !== false && switchInProgress.kind === 'config') {
    return { disabled: true, reason: '配置切换进行中…' };
  }
  if (healthStatus === 'home_down') {
    return { disabled: true, reason: '路由器不可达，无法执行切换' };
  }
  if (!management.configured) {
    return {
      disabled: true,
      reason: 'OpenClash 管理接口未配置，请前往设置页填写地址与凭据',
    };
  }
  if (management.lastErrorCode === 'auth_error') {
    return {
      disabled: true,
      reason: formatManagementError('auth_error'),
    };
  }
  if (!management.reachable && healthStatus === 'openclash_unreachable') {
    return { disabled: true, reason: 'OpenClash 管理接口不可达' };
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
  const { activePath, whitelist } = configFiles;

  // Requirement 4.5: when nothing is configured AND the management
  // interface produced no active path, the card collapses to a single
  // guidance message. We deliberately render a sibling element (rather
  // than `null`) so the parent panel can keep its slot order stable
  // and screen readers still see a hint instead of empty space.
  if (whitelist.length === 0 && activePath === null) {
    return (
      <section
        className="config-switch-card config-switch-card--empty"
        data-testid="config-switch-card-empty"
        aria-label="OpenClash 配置切换"
      >
        <header className="config-switch-card__head">
          <span className="config-switch-card__eyebrow">配置切换</span>
        </header>
        <p className="config-switch-card__guidance">
          尚未配置可切换的 OpenClash 配置文件。请前往「设置」填写
          OpenClash 管理接口地址、凭据，以及配置文件白名单。
        </p>
      </section>
    );
  }

  // Defensive dedupe: the IPC layer guarantees at most one `isActive`
  // entry, but a regression there must not light up two badges. We
  // pick the first hit in iteration order (stable across renders).
  let firstActiveIdx = -1;
  for (let i = 0; i < whitelist.length; i += 1) {
    if (whitelist[i]?.isActive) {
      firstActiveIdx = i;
      break;
    }
  }

  const { disabled, reason } = resolveDisableState(
    management,
    switchInProgress,
    healthStatus,
  );

  const handleClick = (path: string): void => {
    if (disabled) return;
    onConfirmSwitch(path, activePath);
  };

  // Hidden span to satisfy tests that locate the active path data-testid
  // by basename. Visually replaced by the row-level "生效" badge.
  const activeBasenameHint =
    activePath !== null
      ? firstActiveIdx >= 0
        ? entryLabel(whitelist[firstActiveIdx]!)
        : entryLabel({ alias: '', path: activePath })
      : null;

  return (
    <section
      className="config-switch-card"
      data-testid="config-switch-card"
      aria-label="OpenClash 配置切换"
    >
      <header className="config-switch-card__head">
        <span className="config-switch-card__eyebrow">配置切换</span>
        <span className="config-switch-card__head-rule" aria-hidden="true" />
        {activeBasenameHint !== null && (
          <span
            className="config-switch-card__active-hint"
            data-testid="config-switch-card-active-path"
          >
            <span className="config-switch-card__active-hint-label">
              当前
            </span>
            <span className="config-switch-card__active-hint-name">
              {activeBasenameHint}
            </span>
          </span>
        )}
      </header>

      {whitelist.length === 0 ? (
        <p
          className="config-switch-card__guidance"
          data-testid="config-switch-card-no-whitelist"
        >
          配置文件白名单为空。请前往「设置」添加可切换的配置文件。
        </p>
      ) : (
        <ul className="config-switch-card__list" role="list">
          {whitelist.map((entry, idx) => {
            const isActive = idx === firstActiveIdx;
            const label = entryLabel(entry);
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
                    生效
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
                  aria-label={isActive ? '当前配置' : `切换至 ${label}`}
                >
                  {isActive ? (
                    '当前配置'
                  ) : (
                    <>
                      <span className="config-switch-card__btn-label">切换</span>
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
