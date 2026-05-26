// QuickNodeCard — Primary policy group quick-switch card.
//
// One of the two children of `Quick_Actions_Panel` on the expanded
// window. Renders the primary group's name, its current node, and up
// to 5 ranked candidate nodes the user can switch to with a single
// click. The card never lists nodes outside the primary group — that
// affordance lives in `NodeTable` (Requirement 3.8).
//
// Props mirror the corresponding slice of the IPC payload returned by
// `desktop:getNetworkQuickActions`:
//
//   primaryGroup     = NetworkQuickActions['primaryGroup']
//   switchInProgress = NetworkQuickActions['switchInProgress']
//
// Two callbacks let the parent (`QuickActionsPanel`) keep its own
// `switchInProgress` view fresh: `onSwitchStart` is called before the
// IPC fires, `onSwitchComplete` is called once the IPC settles
// (success **or** failure). The card also tracks a local
// `localSwitching` flag so sibling candidate buttons are disabled
// even before the parent observes the new lock state on the next
// `dashboard.updated` push (Requirement 3.7).
//
// Disabled-state rules (Requirement 9.2 + 9.3):
//   • A `'config'` lock disables every candidate button — a kernel
//     reload is in flight and we MUST NOT issue node switches.
//   • A `'node'` lock on this group disables every candidate button.
//   • A `'node'` lock on a different group leaves this card alone.
//   • If `primaryGroup.name === null`, every button is disabled.
//   • While a same-card switch is in flight (`localSwitching`), every
//     other candidate button is disabled.
//
// Errors from the IPC are surfaced inline via `formatManagementError`
// when the orchestrator returns a closed-enum error code, falling
// back to the textual `error.message` for any node-switch error code
// not covered by the management map (e.g. `verify_mismatch` from the
// existing `SwitchNodeService`).
//
// References:
//   • network-quick-actions/design.md §IPC Surface, §Renderer Components
//   • network-quick-actions/requirements.md §Requirement 3, §Requirement 9
//   • desktop-monitor-widget/design.md §Manual Node Switch with Verification

import { useCallback, useState } from 'react';

import { formatManagementError } from '../lib/format';
import type {
  ManagementErrorCode,
  NetworkQuickActions,
  QuickNodeCandidate,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QuickNodeCardProps {
  readonly primaryGroup: NetworkQuickActions['primaryGroup'];
  readonly switchInProgress: NetworkQuickActions['switchInProgress'];
  /** Fired immediately before the `switchNode` IPC is invoked. */
  readonly onSwitchStart?: () => void;
  /** Fired when the IPC settles — both on success and on failure. */
  readonly onSwitchComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The closed set of `ManagementErrorCode` literals, restated locally
 * so we can narrow an arbitrary string from the wire without pulling
 * in a runtime guard from `src/main`. Kept in lock-step with the
 * union in `src/main/types.ts` — adding a new code there is a
 * compile-time `Record` totality error here.
 */
const MANAGEMENT_ERROR_CODES = new Set<ManagementErrorCode>([
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
]);

function isManagementErrorCode(code: string): code is ManagementErrorCode {
  return (MANAGEMENT_ERROR_CODES as Set<string>).has(code);
}

/**
 * Translate any IPC-side error into a user-facing zh-CN string. The
 * management codes go through the i18n map (single source of truth);
 * anything else (the legacy `SwitchNodeResult` codes such as
 * `'verify_mismatch'` or `'switch_in_progress'`) falls back to the
 * orchestrator-supplied message.
 */
function describeSwitchError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  if (error.code === 'switch_in_progress') {
    return formatManagementError('switch_in_progress');
  }
  if (isManagementErrorCode(error.code)) {
    return formatManagementError(error.code);
  }
  return error.message || '切换失败';
}

function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return '—';
  }
  return `${Math.round(ms)}ms`;
}

function formatCandidateLabel(candidate: QuickNodeCandidate): string {
  return `${candidate.nodeName} · ${formatLatency(candidate.avgLatencyMs)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuickNodeCard({
  primaryGroup,
  switchInProgress,
  onSwitchStart,
  onSwitchComplete,
}: QuickNodeCardProps): JSX.Element {
  // Node currently being switched to from this card. Drives the
  // optimistic "切换中…" label on the firing button and disables every
  // sibling candidate button (Requirement 3.7).
  const [localSwitching, setLocalSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groupName = primaryGroup.name;
  const candidates = primaryGroup.candidates;

  // Global / cross-card lock derivation (Requirements 9.2 + 9.3).
  const lockedByConfig = switchInProgress !== false && switchInProgress.kind === 'config';
  const lockedByThisGroup =
    switchInProgress !== false &&
    switchInProgress.kind === 'node' &&
    groupName !== null &&
    switchInProgress.group === groupName;

  const cardLocked = lockedByConfig || lockedByThisGroup || groupName === null;

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const handleSwitch = useCallback(
    async (nodeName: string) => {
      if (groupName === null) return;
      if (localSwitching !== null) return;
      if (cardLocked) return;

      const desktop = window.desktop;
      if (!desktop) {
        setError('desktop bridge 不可用');
        return;
      }

      setLocalSwitching(nodeName);
      setError(null);
      onSwitchStart?.();

      try {
        const result = await desktop.switchNode({ groupName, nodeName });
        if (!result.ok) {
          setError(describeSwitchError(result.error));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '切换发生未知错误';
        setError(message);
      } finally {
        setLocalSwitching(null);
        onSwitchComplete?.();
      }
    },
    [cardLocked, groupName, localSwitching, onSwitchStart, onSwitchComplete],
  );

  // ─── Header ───────────────────────────────────────────────────────────
  const groupLabel = groupName ?? '未识别主组';
  const currentNodeLabel = primaryGroup.currentNode ?? '未选择节点';

  // ─── Body ─────────────────────────────────────────────────────────────
  const hasCandidates = candidates.length > 0;

  return (
    <article
      className="quick-node-card"
      data-testid="quick-node-card"
      data-locked={cardLocked ? 'true' : 'false'}
      aria-label="快速节点切换"
    >
      <header className="quick-node-card__head">
        <span className="quick-node-card__eyebrow">primary group</span>
        <span className="quick-node-card__group" title={groupLabel}>
          {groupLabel}
        </span>
      </header>

      <div className="quick-node-card__current">
        <span className="quick-node-card__current-label">当前节点</span>
        <span
          className="quick-node-card__current-name"
          title={primaryGroup.currentNode ?? ''}
        >
          {currentNodeLabel}
        </span>
      </div>

      {error !== null && (
        <div
          className="quick-node-card__error"
          role="alert"
          data-testid="quick-node-card-error"
          onClick={dismissError}
        >
          {error}
        </div>
      )}

      {hasCandidates ? (
        <ul
          className="quick-node-card__candidates"
          data-testid="quick-node-card-candidates"
        >
          {candidates.map((candidate) => {
            const isFiring = localSwitching === candidate.nodeName;
            const disabledBySibling = localSwitching !== null && !isFiring;
            const disabled = cardLocked || disabledBySibling;

            return (
              <li
                key={candidate.nodeName}
                className="quick-node-card__candidate"
              >
                <button
                  type="button"
                  className="quick-node-card__btn"
                  data-testid={`quick-node-card-btn-${candidate.nodeName}`}
                  data-firing={isFiring ? 'true' : 'false'}
                  disabled={disabled || isFiring}
                  onClick={() => void handleSwitch(candidate.nodeName)}
                  title={formatCandidateLabel(candidate)}
                >
                  <span className="quick-node-card__btn-name">
                    {candidate.nodeName}
                  </span>
                  <span className="quick-node-card__btn-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="quick-node-card__btn-latency">
                    {isFiring ? '切换中…' : formatLatency(candidate.avgLatencyMs)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div
          className="quick-node-card__empty"
          data-testid="quick-node-card-empty"
        >
          暂无可推荐节点
        </div>
      )}
    </article>
  );
}
