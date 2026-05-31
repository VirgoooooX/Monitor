// ConfirmDialog — modal confirmation for the OpenClash config switch.
//
// Used by `ConfigSwitchCard` (task 15.4). Per Requirement 6 of the
// `network-quick-actions` spec, every Config_Switch is gated by an
// explicit confirmation that:
//   • shows the start path, target path (basename only), and a warning
//     that switching restarts the Clash kernel and drops connections;
//   • emits a single `desktop:switchOpenClashConfig` IPC on accept;
//   • writes nothing on cancel;
//   • has NO "remember choice" / "do not ask again" affordance
//     (Requirement 6.5 invariant).
//
// This component owns ONLY the UI: the IPC call lives in the parent
// (`ConfigSwitchCard` wires `onConfirm` to `window.desktop.switchOpenClashConfig`).
//
// Accessibility:
//   • role="dialog", aria-modal="true"
//   • aria-labelledby points at the title
//   • aria-describedby points at the warning text
//   • opens with focus on the cancel button (the safer choice;
//     confirming requires a second deliberate action)
//   • Escape key triggers `onCancel`
//   • Tab/Shift+Tab cycle between the two buttons (simple focus trap)
//   • restores focus to the previously focused element on close

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
} from 'react';

import { useT } from '../lib/i18n';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly startPath: string | null;
  readonly targetPath: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const TITLE_ID = 'confirm-dialog-title';
const DESCRIPTION_ID = 'confirm-dialog-warning';

/**
 * Return the trailing filename of an absolute config path.
 *
 * The router whitelist enforces `/etc/openclash/config/*.yaml` (validated
 * by the main process), but this helper handles a few defensive cases so
 * the dialog never crashes on unexpected input:
 *   • trailing slashes are stripped
 *   • both POSIX (`/`) and Windows (`\`) separators are recognised
 *   • an empty result falls back to the original string
 */
function basename(path: string): string {
  if (!path) return path;
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return trimmed;
  const tail = trimmed.slice(idx + 1);
  return tail.length > 0 ? tail : trimmed;
}

export function ConfirmDialog({
  open,
  startPath,
  targetPath,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Focus management: when the dialog opens, remember whatever was
  // focused before (so we can restore it on close) and move focus
  // to the cancel button (the safer default).
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Defer to the next frame so the button is mounted.
    const id = window.requestAnimationFrame(() => {
      cancelRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(id);
      const prev = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Tab') {
      // Simple two-button focus trap: cycle between cancel and confirm.
      const cancelEl = cancelRef.current;
      const confirmEl = confirmRef.current;
      if (!cancelEl || !confirmEl) return;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === cancelEl) {
          event.preventDefault();
          confirmEl.focus();
        } else if (active !== confirmEl) {
          event.preventDefault();
          cancelEl.focus();
        }
      } else {
        if (active === confirmEl) {
          event.preventDefault();
          cancelEl.focus();
        } else if (active !== cancelEl) {
          event.preventDefault();
          cancelEl.focus();
        }
      }
    }
  };

  const handleBackdropClick = (): void => {
    // Backdrop click is treated as an explicit cancel (matches the
    // Requirement 6.4 "Cancel writes nothing" path; no IPC is sent).
    onCancel();
  };

  const stopPropagation = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    // Prevent backdrop click from firing when the user clicks inside
    // the dialog body itself.
    event.stopPropagation();
  };

  const startLabel =
    startPath && startPath.length > 0 ? startPath : t('confirmDialog.unknown');
  const targetLabel = basename(targetPath);

  return (
    <div
      className="confirm-dialog__backdrop"
      data-testid="confirm-dialog-backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div
        className="confirm-dialog"
        data-testid="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        onClick={stopPropagation}
      >
        <h2 id={TITLE_ID} className="confirm-dialog__title">
          {t('confirmDialog.title')}
        </h2>

        <dl className="confirm-dialog__paths">
          <div className="confirm-dialog__path-row">
            <dt className="confirm-dialog__path-label">
              {t('confirmDialog.startLabel')}
            </dt>
            <dd className="confirm-dialog__path-value">{startLabel}</dd>
          </div>
          <div className="confirm-dialog__path-row">
            <dt className="confirm-dialog__path-label">
              {t('confirmDialog.targetLabel')}
            </dt>
            <dd className="confirm-dialog__path-value">{targetLabel}</dd>
          </div>
        </dl>

        <p
          id={DESCRIPTION_ID}
          className="confirm-dialog__warning"
          role="alert"
        >
          {t('confirmDialog.warning')}
        </p>

        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
          >
            {t('confirmDialog.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--confirm"
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {t('confirmDialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
