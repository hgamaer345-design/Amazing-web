import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { makeId } from '../../../shared/speakers';
import { formatDuration } from '../../../shared/time';
import type {
  ExportFormat,
  TranscriptDetail,
  TranscriptDocument,
  TranscriptSummary,
} from '../../../shared/types';
import { QUALITY_MODE_DEFINITIONS } from '../../../shared/quality';
import { audioUrl, downloadExport, saveDocument, updateTranscript } from '../../api';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useAutosave } from '../../hooks/useAutosave';
import {
  countRowsBySpeaker,
  editRowText,
  mergeWithNext,
  mergeWithPrevious,
  pruneUnusedSpeakers,
  reassignRow,
  reassignRowToNewSpeaker,
  renameSpeaker,
  type EditableDoc,
} from '../../lib/docOps';
import { getSessionAudioUrl, setSessionAudio } from '../../lib/sessionAudio';
import { canRedo, canUndo, createHistory, historyReducer } from '../../lib/undoHistory';
import { AudioPlayer, type AudioSource } from './AudioPlayer';
import { DeleteAudioButton, DeleteTranscriptButton } from './DeleteActions';
import { EditableTitle } from './EditableTitle';
import { ExportMenu } from './ExportMenu';
import { formatDateTime, languageName } from './format';
import { RedoIcon, UndoIcon } from './icons';
import { SaveStatus } from './SaveStatus';
import { SpeakerLegend } from './SpeakerLegend';
import { SpeakerTimeline } from './SpeakerTimeline';
import { TranscriptTable } from './TranscriptTable';
import type { RowActions } from './TranscriptRowView';

export interface TranscriptEditorProps {
  transcript: TranscriptDetail;
  /** The document as loaded; later edits live in the editor's own history. */
  document: TranscriptDocument;
  onSummaryChange: (summary: TranscriptSummary) => void;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color']);

/** Typing targets where Ctrl/Cmd+Z must keep its native meaning. */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el as HTMLElement).isContentEditable
  );
}

/** Controls where Space has its own meaning (activate, type, toggle). */
function isSpaceTarget(el: Element | null): boolean {
  return !!el?.closest(
    'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable=""], [role="button"], [role^="menuitem"], [role="slider"], [role="checkbox"]',
  );
}

function toEditable(doc: TranscriptDocument): EditableDoc {
  return { speakers: doc.speakers, rows: doc.rows };
}

export function TranscriptEditor({ transcript, document: loaded, onSummaryChange }: TranscriptEditorProps) {
  const id = transcript.id;
  const [history, dispatch] = useReducer(historyReducer<EditableDoc>, loaded, (d) =>
    createHistory(toEditable(d)),
  );
  const doc = history.present;
  const [conflict, setConflict] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [followAlong, setFollowAlong] = useState(false);

  // ---- Autosave --------------------------------------------------------------------------------
  const save = useCallback(
    async (d: EditableDoc, baseVersion: number) => {
      const { speakers, rows } = pruneUnusedSpeakers(d);
      return (await saveDocument(id, { baseVersion, speakers, rows })).version;
    },
    [id],
  );
  const onConflict = useCallback((serverDoc: EditableDoc) => {
    dispatch({ type: 'reset', present: serverDoc });
    setConflict(true);
  }, []);
  const autosave = useAutosave({ doc, initialVersion: loaded.version, save, onConflict });

  useEffect(() => {
    if (!autosave.dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      e.returnValue = true;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [autosave.dirty]);

  // ---- Audio -----------------------------------------------------------------------------------
  // Priority: a file attached here > the file uploaded in this browser session > the server copy.
  const [attached, setAttached] = useState<{ url: string; fileName: string } | null>(null);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set());
  const [audioError, setAudioError] = useState<string | null>(null);
  const source = useMemo<AudioSource | null>(() => {
    const candidates: AudioSource[] = [];
    if (attached) candidates.push({ kind: 'local', url: attached.url, fileName: attached.fileName });
    const sessionUrl = getSessionAudioUrl(id);
    if (sessionUrl && sessionUrl !== attached?.url) candidates.push({ kind: 'session', url: sessionUrl });
    if (transcript.audioAvailable) candidates.push({ kind: 'server', url: audioUrl(id) });
    return candidates.find((c) => !failedUrls.has(c.url)) ?? null;
  }, [attached, failedUrls, id, transcript.audioAvailable]);

  const lastEndMs = doc.rows[doc.rows.length - 1]?.endMs ?? null;
  const player = useAudioPlayer({
    src: source?.url ?? null,
    fallbackDurationMs: transcript.durationSec != null ? transcript.durationSec * 1000 : lastEndMs,
    onError: (url, message) => {
      setFailedUrls((prev) => new Set(prev).add(url));
      setAudioError(message);
    },
  });
  const hasAudio = source != null && player.status !== 'error';

  const attachFile = useCallback(
    (file: File) => {
      setAttached({ url: setSessionAudio(id, file), fileName: file.name });
      setAudioError(null);
    },
    [id],
  );

  // ---- Editing ---------------------------------------------------------------------------------
  const apply = useCallback(
    (update: (d: EditableDoc) => EditableDoc) => dispatch({ type: 'apply', update }),
    [],
  );
  const { seek, toggle } = player;
  const actions = useMemo<RowActions>(
    () => ({
      playFrom: (ms) => seek(ms, { play: true }),
      editText: (rowId, text) => apply((d) => editRowText(d, rowId, text)),
      merge: (rowId, direction) =>
        apply((d) => (direction === 'next' ? mergeWithNext(d, rowId) : mergeWithPrevious(d, rowId))),
      reassign: (rowId, speakerId) => apply((d) => reassignRow(d, rowId, speakerId)),
      reassignNew: (rowId, name) => {
        // Generated outside the reducer so a re-run (StrictMode) produces the same document.
        const speakerId = makeId('spk');
        apply((d) => reassignRowToNewSpeaker(d, rowId, name, speakerId));
      },
      renameSpeaker: (speakerId, name) => apply((d) => renameSpeaker(d, speakerId, name)),
    }),
    [apply, seek],
  );
  const rowCounts = useMemo(() => countRowsBySpeaker(doc.rows), [doc.rows]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[aria-modal="true"]')) return;
      if (e.ctrlKey || e.metaKey) {
        if (isTextField(target)) return;
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
        } else if (key === 'y' && e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          dispatch({ type: 'redo' });
        }
        return;
      }
      if (e.key === ' ' && !e.shiftKey && hasAudio && !isSpaceTarget(target)) {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hasAudio, toggle]);

  // ---- Header actions --------------------------------------------------------------------------
  const saveTitle = useCallback(
    async (title: string) => onSummaryChange(await updateTranscript(id, { title })),
    [id, onSummaryChange],
  );

  const exportAs = async (format: ExportFormat) => {
    setExporting(true);
    setExportError(null);
    const result = await autosave.flush();
    setExporting(false);
    if (result === 'saved') {
      try {
        await downloadExport(id, format);
      } catch {
        setExportError('The export couldn’t be created. Please try again.');
      }
    } else if (result === 'conflict') {
      setExportError(
        'The export was cancelled because this transcript was changed somewhere else. Check the latest version, then export again.',
      );
    } else {
      setExportError(
        'Your latest changes couldn’t be saved, so the export was cancelled. Retry saving, then export again.',
      );
    }
  };

  return (
    <div className="tx-editor">
      <header className="tx-header">
        <div className="tx-header-main">
          <EditableTitle title={transcript.title} onSave={saveTitle} />
          <dl className="tx-meta">
            <div>
              <dt>File</dt>
              <dd className="tx-meta-file">{transcript.originalFilename}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(transcript.durationSec)}</dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{languageName(transcript.languageCode)}</dd>
            </div>
            <div>
              <dt>Speakers</dt>
              <dd>{rowCounts.size}</dd>
            </div>
            <div>
              <dt>Quality</dt>
              <dd className="tx-quality-badge" data-quality={transcript.quality}>
                {QUALITY_MODE_DEFINITIONS[transcript.quality].label}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(transcript.createdAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="tx-header-side">
          <ExportMenu busy={exporting} onExport={(format) => void exportAs(format)} />
        </div>
      </header>

      <div className="tx-toolbar">
        <div className="tx-toolbar-group">
          <button
            type="button"
            className="btn btn-sm"
            aria-keyshortcuts="Control+Z Meta+Z"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo(history)}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <UndoIcon />
            Undo
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!canRedo(history)}
            onClick={() => dispatch({ type: 'redo' })}
          >
            <RedoIcon />
            Redo
          </button>
          <SaveStatus status={autosave.status} error={autosave.error} onRetry={() => void autosave.flush()} />
        </div>
        <div className="tx-toolbar-group tx-toolbar-end">
          {transcript.audioAvailable && <DeleteAudioButton transcriptId={id} onDeleted={onSummaryChange} />}
          <DeleteTranscriptButton
            transcriptId={id}
            title={transcript.title}
            className="btn btn-danger btn-sm"
            onDeleted={autosave.cancel}
          />
        </div>
      </div>

      {conflict && (
        <div className="alert alert-warning tx-notice" role="alert">
          <span>This transcript was changed somewhere else. The latest version has been loaded.</span>
          <button type="button" className="btn btn-sm" onClick={() => setConflict(false)}>
            Dismiss
          </button>
        </div>
      )}
      {exportError && (
        <div className="alert alert-error tx-notice" role="alert">
          <span>{exportError}</span>
          <button type="button" className="btn btn-sm" onClick={() => setExportError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="tx-player-sticky">
        <AudioPlayer
          player={player}
          source={source}
          error={audioError}
          followAlong={followAlong}
          onFollowAlongChange={setFollowAlong}
          onAttachFile={attachFile}
        />
        <SpeakerTimeline
          rows={doc.rows}
          speakers={doc.speakers}
          durationMs={
            player.durationMs ?? (transcript.durationSec != null ? transcript.durationSec * 1000 : null)
          }
          time={player.time}
          onSeek={hasAudio ? (ms) => seek(ms, { play: true }) : undefined}
        />
      </div>

      <SpeakerLegend speakers={doc.speakers} rowCounts={rowCounts} onRename={actions.renameSpeaker} />

      <TranscriptTable
        rows={doc.rows}
        speakers={doc.speakers}
        time={player.time}
        trackPlayback={hasAudio}
        followAlong={followAlong}
        actions={actions}
      />
    </div>
  );
}
