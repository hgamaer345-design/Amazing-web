import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ERROR_MESSAGES } from '../../../shared/errors';
import type { TranscriptSummary } from '../../../shared/types';
import { ApiError, deleteAudio, deleteTranscript } from '../../api';
import { clearSessionAudio } from '../../lib/sessionAudio';
import { ConfirmDialog } from './ConfirmDialog';
import { TrashIcon } from './icons';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : ERROR_MESSAGES.INTERNAL;
}

export interface DeleteTranscriptButtonProps {
  transcriptId: string;
  title: string;
  /** Button text; e.g. "Cancel and delete" while processing. */
  label?: string;
  className?: string;
  /** Called after the server confirmed the deletion, before navigating home. */
  onDeleted?: () => void;
}

export function DeleteTranscriptButton({
  transcriptId,
  title,
  label = 'Delete transcript',
  className = 'btn btn-danger',
  onDeleted,
}: DeleteTranscriptButtonProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteTranscript(transcriptId);
    } catch (err) {
      // Already gone counts as success: the user wanted it deleted.
      if (!(err instanceof ApiError && err.code === 'NOT_FOUND')) {
        setBusy(false);
        setError(errorMessage(err));
        return;
      }
    }
    clearSessionAudio(transcriptId);
    onDeleted?.();
    navigate('/');
  };

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <TrashIcon />
        {label}
      </button>
      {open && (
        <ConfirmDialog
          title="Delete this transcript?"
          message={
            <p>
              “{title}” and any audio stored for it will be permanently deleted. This can’t be undone.
            </p>
          }
          confirmLabel="Delete permanently"
          busyLabel="Deleting…"
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setOpen(false);
            setError(null);
          }}
        />
      )}
    </>
  );
}

export interface DeleteAudioButtonProps {
  transcriptId: string;
  onDeleted: (summary: TranscriptSummary) => void;
}

export function DeleteAudioButton({ transcriptId, onDeleted }: DeleteAudioButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const summary = await deleteAudio(transcriptId);
      setOpen(false);
      setBusy(false);
      onDeleted(summary);
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>
        Delete audio from server
      </button>
      {open && (
        <ConfirmDialog
          title="Delete the audio from the server?"
          message={
            <p>
              The transcript stays and can still be edited and exported. To play it back later you’ll need to
              attach the original audio file.
            </p>
          }
          confirmLabel="Delete audio"
          busyLabel="Deleting…"
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setOpen(false);
            setError(null);
          }}
        />
      )}
    </>
  );
}
