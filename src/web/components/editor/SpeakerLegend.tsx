import { memo, useEffect, useId, useRef, useState } from 'react';
import type { Speaker } from '../../../shared/types';
import { speakerStyleVars } from '../../lib/speakerStyle';
import { EditIcon } from './icons';
import { SpeakerNameForm } from './SpeakerNameForm';

export interface SpeakerLegendProps {
  speakers: readonly Speaker[];
  /** Rows per speaker id. */
  rowCounts: ReadonlyMap<string, number>;
  onRename: (speakerId: string, name: string) => void;
}

// True when the edit ended from inside the form (Enter, Escape, a button) rather than by focus moving away.
function focusInForm(): boolean {
  return document.activeElement?.closest('.spk-legend-form') != null;
}

function rowCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'row' : 'rows'}`;
}

/** One chip per speaker in its colour, with its row count. Click a chip to rename the speaker inline. */
export const SpeakerLegend = memo(function SpeakerLegend({ speakers, rowCounts, onRename }: SpeakerLegendProps) {
  const headingId = useId();
  const [editingId, setEditingId] = useState<string | null>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (editingId !== null || !restoreFocusRef.current) return;
    chipRefs.current.get(restoreFocusRef.current)?.focus();
    restoreFocusRef.current = null;
  }, [editingId]);

  const stopEditing = (speakerId: string, returnFocus: boolean) => {
    restoreFocusRef.current = returnFocus ? speakerId : null;
    setEditingId(null);
  };

  return (
    <section className="spk-legend" aria-labelledby={headingId}>
      <h2 id={headingId} className="spk-legend-title">
        Speakers
        <span className="spk-legend-hint"> · select a name to rename it</span>
      </h2>
      <ul className="spk-legend-list">
        {speakers.map((s) => {
          const countLabel = rowCountLabel(rowCounts.get(s.id) ?? 0);
          return (
            <li key={s.id} className="spk-legend-item" style={speakerStyleVars(s.colorIndex)}>
              {editingId === s.id ? (
                <SpeakerNameForm
                  className="spk-legend-form"
                  initialName={s.name}
                  label={`New name for ${s.name}`}
                  commitOnBlur
                  onSubmit={(name) => {
                    onRename(s.id, name);
                    stopEditing(s.id, focusInForm());
                  }}
                  onCancel={() => stopEditing(s.id, focusInForm())}
                />
              ) : (
                <button
                  ref={(el) => {
                    if (el) chipRefs.current.set(s.id, el);
                    else chipRefs.current.delete(s.id);
                  }}
                  type="button"
                  className="spk-chip spk-chip-legend"
                  aria-label={`Rename ${s.name} (${countLabel})`}
                  onClick={() => setEditingId(s.id)}
                >
                  <span className="spk-dot" aria-hidden="true" />
                  <span className="spk-chip-name">{s.name}</span>
                  <span className="spk-count">{countLabel}</span>
                  <EditIcon />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
});
