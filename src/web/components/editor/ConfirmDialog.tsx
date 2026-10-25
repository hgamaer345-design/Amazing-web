import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';

export interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal confirmation for destructive actions. Focus starts on Cancel (the safe choice), Tab is kept
 * inside, Escape cancels, and focus returns to whatever opened it.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <div id={messageId} className="dialog-message">
          {message}
        </div>
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={onConfirm} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
