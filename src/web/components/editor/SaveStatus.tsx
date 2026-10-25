import type { SaveStatus as Status } from '../../hooks/useAutosave';
import { AlertIcon, CheckIcon } from './icons';

export interface SaveStatusProps {
  status: Status;
  error: string | null;
  onRetry: () => void;
}

/** "Saving… / All changes saved / Couldn't save — Retry", announced politely to screen readers. */
export function SaveStatus({ status, error, onRetry }: SaveStatusProps) {
  return (
    <div className={`save-status save-status-${status}`}>
      <span role="status" aria-live="polite" className="save-status-text">
        {status === 'saved' && (
          <>
            <CheckIcon />
            All changes saved
          </>
        )}
        {(status === 'pending' || status === 'saving') && (
          <>
            <span className="spinner save-status-spinner" aria-hidden="true" />
            Saving…
          </>
        )}
        {status === 'error' && (
          <>
            <AlertIcon />
            <span>
              Couldn’t save
              {error && <span className="save-status-detail">: {error}</span>}
            </span>
          </>
        )}
      </span>
      {status === 'error' && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
