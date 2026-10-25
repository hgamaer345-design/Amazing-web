import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { MAX_SPEAKER_NAME_LENGTH, normalizeSpeakerName } from '../../lib/docOps';

export interface SpeakerNameFormProps {
  initialName: string;
  /** Accessible label of the text field, e.g. "Speaker name". */
  label: string;
  submitLabel?: string;
  /** Show the label visibly (inside menus) or only to assistive tech (inline in the legend). */
  showLabel?: boolean;
  /** Leaving the field saves a valid name (or cancels when it is empty). */
  commitOnBlur?: boolean;
  className?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

// Keeps focus in the text field when a button is pressed, so its blur doesn't fire first.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** Name input with Save/Cancel. Enter saves, Escape cancels; an empty name is rejected. */
export function SpeakerNameForm({
  initialName,
  label,
  submitLabel = 'Save',
  showLabel = false,
  commitOnBlur = false,
  className,
  onSubmit,
  onCancel,
}: SpeakerNameFormProps) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialName);
  const [invalid, setInvalid] = useState(false);
  const doneRef = useRef(false);

  const finish = (save: boolean) => {
    if (doneRef.current) return;
    const name = normalizeSpeakerName(value);
    if (save && !name) {
      setInvalid(true);
      return;
    }
    doneRef.current = true;
    if (save) onSubmit(name);
    else onCancel();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    finish(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // Keep a surrounding popover from handling the same key a second time.
    e.stopPropagation();
    finish(false);
  };

  const onBlur = () => {
    if (!commitOnBlur || doneRef.current) return;
    if (normalizeSpeakerName(value)) finish(true);
    else finish(false);
  };

  return (
    <form className={`spk-name-form${className ? ` ${className}` : ''}`} onSubmit={submit} noValidate>
      <label htmlFor={inputId} className={showLabel ? 'field-label' : 'visually-hidden'}>
        {label}
      </label>
      <input
        id={inputId}
        className="input"
        value={value}
        maxLength={MAX_SPEAKER_NAME_LENGTH}
        autoComplete="off"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setValue(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
      />
      {invalid && (
        <p id={errorId} className="spk-name-error" role="alert">
          Enter a name.
        </p>
      )}
      <div className="spk-name-actions">
        <button type="submit" className="btn btn-primary btn-sm" onMouseDown={keepFocus}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-sm" onMouseDown={keepFocus} onClick={() => finish(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
