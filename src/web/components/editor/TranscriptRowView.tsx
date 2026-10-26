import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import { formatHms } from '../../../shared/time';
import type { Speaker, TranscriptRow } from '../../../shared/types';
import { speakerStyleVars } from '../../lib/speakerStyle';
import { textAttributes } from './format';
import { EditIcon, MergeDownIcon, MergeUpIcon } from './icons';
import { RowTextEditor } from './RowTextEditor';
import { SpeakerMenu } from './SpeakerMenu';

export type MergeDirection = 'previous' | 'next';

/** Stable callbacks shared by all rows (kept in one object so memoised rows don't re-render). */
export interface RowActions {
  /** Seeks the audio to `ms` and plays. */
  playFrom: (ms: number) => void;
  editText: (rowId: string, text: string) => void;
  merge: (rowId: string, direction: MergeDirection) => void;
  reassign: (rowId: string, speakerId: string) => void;
  reassignNew: (rowId: string, name: string) => void;
  renameSpeaker: (speakerId: string, name: string) => void;
}

export interface TranscriptRowViewProps {
  row: TranscriptRow;
  index: number;
  speaker: Speaker;
  speakers: readonly Speaker[];
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  actions: RowActions;
  /** Language of rows that don't carry their own (the transcript's languageCode). */
  defaultLang?: string | null;
}

// Clicks on these never seek: they have their own behaviour (or the user is working in a popup).
const INTERACTIVE = 'button, a, input, textarea, select, label, [data-no-seek]';

export const TranscriptRowView = memo(function TranscriptRowView({
  row,
  index,
  speaker,
  speakers,
  isActive,
  isFirst,
  isLast,
  actions,
  defaultLang = null,
}: TranscriptRowViewProps) {
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const n = index + 1;
  const start = formatHms(row.startMs);
  // Only the text gets the language and direction: the table itself stays left to right.
  const lang = row.lang ?? defaultLang;

  useEffect(() => {
    if (!editing && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      editButtonRef.current?.focus();
    }
  }, [editing]);

  const stopEditing = (viaKeyboard: boolean) => {
    restoreFocusRef.current = viaKeyboard;
    setEditing(false);
  };

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (editing || (e.target as Element).closest(INTERACTIVE)) return;
    // Let people select text to copy without jumping the audio.
    if (window.getSelection()?.toString()) return;
    actions.playFrom(row.startMs);
  };

  const className = `tx-row${isActive ? ' is-active' : ''}${editing ? ' is-editing' : ''}`;

  return (
    <tr
      className={className}
      style={speakerStyleVars(speaker.colorIndex)}
      aria-current={isActive ? 'true' : undefined}
      data-row-id={row.id}
      onClick={onRowClick}
    >
      <td className="tx-cell-num">
        <span className="tx-num-prefix" aria-hidden="true">
          #
        </span>
        {n}
      </td>
      <td className="tx-cell-speaker">
        <SpeakerMenu
          rowId={row.id}
          rowNumber={n}
          speaker={speaker}
          speakers={speakers}
          onRenameSpeaker={actions.renameSpeaker}
          onReassign={actions.reassign}
          onReassignNew={actions.reassignNew}
        />
      </td>
      <td className="tx-cell-start">
        <button
          type="button"
          className="tx-time-button"
          aria-label={`Play row ${n} from ${start}`}
          onClick={() => actions.playFrom(row.startMs)}
        >
          {start}
        </button>
      </td>
      <td className="tx-cell-end">
        <span className="tx-time">{formatHms(row.endMs)}</span>
      </td>
      <td
        className="tx-cell-text"
        onDoubleClick={() => {
          if (!editing) setEditing(true);
        }}
      >
        {editing ? (
          <RowTextEditor
            initialText={row.text}
            label={`Text of row ${n}`}
            lang={lang}
            onCommit={(text, viaKeyboard) => {
              actions.editText(row.id, text);
              stopEditing(viaKeyboard);
            }}
            onCancel={stopEditing}
          />
        ) : row.text ? (
          <p className="tx-text" {...textAttributes(lang)}>
            {row.text}
          </p>
        ) : (
          <p className="tx-text">
            <span className="tx-text-empty">No text</span>
          </p>
        )}
      </td>
      <td className="tx-cell-actions">
        <div className="tx-actions">
          <button
            ref={editButtonRef}
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={`Edit text of row ${n}`}
            title="Edit text"
            disabled={editing}
            data-action="edit"
            onClick={() => setEditing(true)}
          >
            <EditIcon />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={`Merge row ${n} with previous row`}
            title="Merge with previous row"
            disabled={isFirst}
            data-action="merge-previous"
            onClick={() => actions.merge(row.id, 'previous')}
          >
            <MergeUpIcon />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={`Merge row ${n} with next row`}
            title="Merge with next row"
            disabled={isLast}
            data-action="merge-next"
            onClick={() => actions.merge(row.id, 'next')}
          >
            <MergeDownIcon />
          </button>
        </div>
      </td>
    </tr>
  );
});
