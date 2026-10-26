import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { DOCUMENT_LIMITS } from '../../../shared/document';
import { textAttributes } from './format';

export interface RowTextEditorProps {
  initialText: string;
  /** Accessible label, e.g. "Text of row 3". */
  label: string;
  /** Language of the text (sets `lang` and the writing direction); null = unknown. */
  lang?: string | null;
  /** `viaKeyboard` is false when the edit ended because focus moved elsewhere. */
  onCommit: (text: string, viaKeyboard: boolean) => void;
  onCancel: (viaKeyboard: boolean) => void;
}

const keepFocus = (e: MouseEvent) => e.preventDefault();

/** Auto-growing textarea. Enter or leaving the field saves, Shift+Enter adds a line break, Escape cancels. */
export function RowTextEditor({ initialText, label, lang, onCommit, onCancel }: RowTextEditorProps) {
  const hintId = useId();
  const [value, setValue] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = (save: boolean, viaKeyboard: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (save) onCommit(value, viaKeyboard);
    else onCancel(viaKeyboard);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari sends the Enter that confirms an IME candidate (Japanese, Chinese, Korean…) after the
    // composition has ended, so isComposing is false; keyCode 229 still marks it as IME input.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false, true);
    }
  };

  return (
    <div className="tx-editor-field">
      <textarea
        ref={ref}
        className="textarea tx-textarea"
        value={value}
        rows={1}
        maxLength={DOCUMENT_LIMITS.maxRowTextLength}
        aria-label={label}
        aria-describedby={hintId}
        {...textAttributes(lang)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true, false)}
      />
      <div className="tx-editor-bar">
        <span id={hintId} className="tx-editor-hint">
          Enter to save · Shift+Enter for a new line · Esc to cancel
        </span>
        <span className="tx-editor-buttons">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onMouseDown={keepFocus}
            onClick={() => finish(true, true)}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onMouseDown={keepFocus}
            onClick={() => finish(false, true)}
          >
            Cancel
          </button>
        </span>
      </div>
    </div>
  );
}
