import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Speaker, TranscriptRow } from '../../../shared/types';
import type { TimeStore } from '../../hooks/useAudioPlayer';
import { findActiveRowIndex } from '../../lib/activeRow';
import { TranscriptRowView, type MergeDirection, type RowActions } from './TranscriptRowView';

export interface TranscriptTableProps {
  rows: readonly TranscriptRow[];
  speakers: readonly Speaker[];
  time: TimeStore;
  /** Highlight the row at the playback position (only meaningful while audio is loaded). */
  trackPlayback: boolean;
  /** Scroll the active row into view as playback moves on. */
  followAlong: boolean;
  actions: RowActions;
  /** The transcript's language, for rows that don't carry their own. */
  languageCode?: string | null;
}

const UNKNOWN_SPEAKER: Speaker = { id: '', name: 'Unknown speaker', colorIndex: 9 };

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isEditingInside(container: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    !!active && container.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')
  );
}

export function TranscriptTable({
  rows,
  speakers,
  time,
  trackPlayback,
  followAlong,
  actions,
  languageCode = null,
}: TranscriptTableProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  const starts = useMemo(() => rows.map((r) => r.startMs), [rows]);
  const speakerById = useMemo(() => new Map(speakers.map((s) => [s.id, s])), [speakers]);

  // Only this component re-renders when the active row changes; memoised rows whose props are
  // unchanged (all but the previous and the new active row) skip rendering.
  const getActiveIndex = useCallback(
    () => (trackPlayback ? findActiveRowIndex(starts, time.get()) : -1),
    [trackPlayback, starts, time],
  );
  const activeIndex = useSyncExternalStore(time.subscribe, getActiveIndex, getActiveIndex);

  useEffect(() => {
    const table = tableRef.current;
    if (!followAlong || activeIndex < 0 || !table || isEditingInside(table)) return;
    const rowEl = table.tBodies[0]?.rows[activeIndex];
    if (!rowEl || typeof rowEl.scrollIntoView !== 'function') return;
    const stickyBottom =
      table.closest('.tx-editor')?.querySelector('.tx-player-sticky')?.getBoundingClientRect().bottom ?? 0;
    const rect = rowEl.getBoundingClientRect();
    if (rect.top >= stickyBottom && rect.bottom <= window.innerHeight) return;
    rowEl.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [activeIndex, followAlong]);

  // After a merge the clicked button may be gone (merge with previous removes its row) or disabled,
  // so move focus to the merged row instead of dropping it on <body>.
  const rowsRef = useRef(rows);
  const pendingFocusRef = useRef<{ rowId: string; direction: MergeDirection } | null>(null);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    const pending = pendingFocusRef.current;
    const table = tableRef.current;
    if (!pending || !table) return;
    pendingFocusRef.current = null;
    const rowEl = Array.from(table.tBodies[0]?.rows ?? []).find((tr) => tr.dataset.rowId === pending.rowId);
    if (!rowEl) return;
    const same = rowEl.querySelector<HTMLButtonElement>(`[data-action="merge-${pending.direction}"]`);
    const target =
      same && !same.disabled ? same : rowEl.querySelector<HTMLButtonElement>('[data-action="edit"]');
    target?.focus();
  }, [rows]);

  const rowActions = useMemo<RowActions>(
    () => ({
      ...actions,
      merge: (rowId, direction) => {
        const list = rowsRef.current;
        const index = list.findIndex((r) => r.id === rowId);
        const mergedId = direction === 'previous' ? list[index - 1]?.id : rowId;
        if (mergedId) pendingFocusRef.current = { rowId: mergedId, direction };
        actions.merge(rowId, direction);
      },
    }),
    [actions],
  );

  if (rows.length === 0) {
    return (
      <div className="card empty-state">
        <p>This transcript has no rows.</p>
      </div>
    );
  }

  return (
    <div className="tx-table-wrap">
      <table ref={tableRef} className="tx-table">
        <caption className="visually-hidden">
          Transcript. Select a row or its start time to play the audio from there.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="tx-col-num">
              #
            </th>
            <th scope="col" className="tx-col-speaker">
              Speaker
            </th>
            <th scope="col" className="tx-col-time">
              Start
            </th>
            <th scope="col" className="tx-col-time">
              End
            </th>
            <th scope="col" className="tx-col-text">
              Text
            </th>
            <th scope="col" className="tx-col-actions">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <TranscriptRowView
              key={row.id}
              row={row}
              index={i}
              speaker={speakerById.get(row.speakerId) ?? UNKNOWN_SPEAKER}
              speakers={speakers}
              isActive={i === activeIndex}
              isFirst={i === 0}
              isLast={i === rows.length - 1}
              actions={rowActions}
              defaultLang={languageCode}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
