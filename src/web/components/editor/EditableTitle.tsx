import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ERROR_MESSAGES } from '../../../shared/errors';
import { ApiError } from '../../api';
import { EditIcon } from './icons';

export const MAX_TITLE_LENGTH = 200;

export interface EditableTitleProps {
  title: string;
  /** Persists the new title; rejects with an ApiError to show its message. */
  onSave: (title: string) => Promise<void>;
}

/** The page heading, with a "Rename transcript" button that swaps it for an inline form. */
export function EditableTitle({ title, onSave }: EditableTitleProps) {
  const inputId = useId();
  const errorId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    editButtonRef.current?.focus();
  }, [editing]);

  const start = () => {
    setValue(title);
    setError(null);
    setEditing(true);
  };

  const stop = () => {
    restoreFocusRef.current = true;
    setEditing(false);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (!next) {
      setError('Enter a title.');
      return;
    }
    if (next === title) {
      stop();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setSaving(false);
      stop();
    } catch (err) {
      setSaving(false);
      setError(err instanceof ApiError ? err.message : ERROR_MESSAGES.INTERNAL);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && !saving) {
      e.preventDefault();
      stop();
    }
  };

  if (!editing) {
    return (
      <div className="tx-title-row">
        <h1 className="tx-title">{title}</h1>
        <button
          ref={editButtonRef}
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Rename transcript"
          title="Rename transcript"
          onClick={start}
        >
          <EditIcon />
        </button>
      </div>
    );
  }

  return (
    <form className="tx-title-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={inputId} className="visually-hidden">
        Transcript title
      </label>
      <input
        id={inputId}
        className="input tx-title-input"
        value={value}
        maxLength={MAX_TITLE_LENGTH}
        autoFocus
        autoComplete="off"
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="btn btn-sm" onClick={stop} disabled={saving}>
        Cancel
      </button>
      {error && (
        <p id={errorId} className="tx-title-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
