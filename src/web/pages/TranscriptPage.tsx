import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ERROR_MESSAGES } from '../../shared/errors';
import type { TranscriptDetail, TranscriptSummary } from '../../shared/types';
import { ApiError, getTranscript, isDemoMode, retryTranscript } from '../api';
import ProcessingSteps from '../components/ProcessingSteps';
import { DeleteTranscriptButton } from '../components/editor/DeleteActions';
import { TranscriptEditor } from '../components/editor/TranscriptEditor';
import '../components/editor/editor.css';
import { processingPollDelay, usePolling } from '../hooks/usePolling';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'load-error'; message: string }
  | { kind: 'ready'; transcript: TranscriptDetail };

const APP_TITLE = 'Speaker Transcriber';

function isProcessing(t: TranscriptDetail): boolean {
  return t.status === 'queued' || t.status === 'transcribing' || t.status === 'separating';
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : ERROR_MESSAGES.INTERNAL;
}

function errorHeading(t: TranscriptDetail): string {
  switch (t.error?.code) {
    case 'NO_SPEECH':
      return 'No speech detected';
    case 'TRANSCRIPTION_TIMEOUT':
      return 'Transcription timed out';
    default:
      return 'Transcription failed';
  }
}

export default function TranscriptPage() {
  const { id = '' } = useParams();
  // A different id is a different transcript: start from a clean slate (history, autosave, player).
  return <TranscriptView key={id} id={id} />;
}

function TranscriptView({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [pollFailing, setPollFailing] = useState(false);

  const load = useCallback(async () => {
    try {
      const transcript = await getTranscript(id);
      setState({ kind: 'ready', transcript });
      setPollFailing(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        setState({ kind: 'not-found' });
        return;
      }
      // Keep showing what we have while polling; only a failed first load replaces the page.
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'load-error', message: messageOf(err) }));
      setPollFailing(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const transcript = state.kind === 'ready' ? state.transcript : null;
  usePolling({
    enabled: transcript != null && isProcessing(transcript),
    poll: load,
    delayMs: processingPollDelay,
  });

  const title = transcript?.title;
  useEffect(() => {
    document.title = title ? `${title} – ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);

  const onSummaryChange = useCallback((summary: TranscriptSummary) => {
    setState((prev) =>
      prev.kind === 'ready' ? { kind: 'ready', transcript: { ...prev.transcript, ...summary } } : prev,
    );
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="tx-page-state" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading transcript…
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <div className="page-narrow">
        <div className="card empty-state tx-state-card">
          <h1>Transcript not found</h1>
          <p>{ERROR_MESSAGES.NOT_FOUND}</p>
          <Link to="/" className="btn btn-primary">
            Go to your transcripts
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === 'load-error') {
    return (
      <div className="page-narrow">
        <div className="card tx-state-card">
          <h1>Couldn’t load this transcript</h1>
          <div className="alert alert-error" role="alert">
            {state.message}
          </div>
          <div className="tx-state-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setState({ kind: 'loading' });
                void load();
              }}
            >
              Try again
            </button>
            <Link to="/" className="btn">
              Go to your transcripts
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const t = state.transcript;

  if (isProcessing(t)) {
    return (
      <div className="page-narrow">
        <div className="card tx-state-card">
          <h1 className="tx-state-title">{t.title}</h1>
          <ProcessingSteps
            stage={t.status}
            progress={t.progress}
            fileName={t.originalFilename}
            durationSec={t.durationSec}
            error={t.error}
          />
          {pollFailing && (
            <p className="tx-poll-warning" role="status">
              Having trouble reaching the server. Still trying…
            </p>
          )}
          <p className="field-hint">
            {isDemoMode
              ? 'Transcription runs in this browser tab: you can open other pages here or switch tabs, but keep ' +
                'this tab open until it finishes.'
              : 'You can leave this page; the transcript will keep processing on the server.'}
          </p>
          <div className="tx-state-actions">
            <Link to="/" className="btn">
              Upload another file
            </Link>
            <DeleteTranscriptButton transcriptId={t.id} title={t.title} label="Cancel and delete" />
          </div>
        </div>
      </div>
    );
  }

  if (t.status === 'error') return <TranscriptErrorCard transcript={t} onRetried={load} />;

  if (!t.document) {
    return (
      <div className="page-narrow">
        <div className="card tx-state-card">
          <h1>{t.title}</h1>
          <div className="alert alert-error" role="alert">
            {ERROR_MESSAGES.INTERNAL}
          </div>
        </div>
      </div>
    );
  }

  return <TranscriptEditor transcript={t} document={t.document} onSummaryChange={onSummaryChange} />;
}

function TranscriptErrorCard({
  transcript: t,
  onRetried,
}: {
  transcript: TranscriptDetail;
  onRetried: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryTranscript(t.id);
      await onRetried();
    } catch (err) {
      setRetryError(messageOf(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="page-narrow">
      <div className="card tx-state-card tx-error-card">
        <p className="tx-state-eyebrow">{t.title}</p>
        <h1>{errorHeading(t)}</h1>
        <div className="alert alert-error" role="alert">
          {t.error?.message ?? ERROR_MESSAGES.TRANSCRIPTION_FAILED}
        </div>
        {t.error?.detail && (
          <details className="tx-error-detail">
            <summary>Technical details</summary>
            <pre>{t.error.detail}</pre>
          </details>
        )}
        {!t.audioAvailable && (
          <p className="field-hint">
            The audio is no longer stored on the server, so this transcript can’t be retried. Upload the file
            again to try once more.
          </p>
        )}
        {retryError && (
          <div className="alert alert-error" role="alert">
            {retryError}
          </div>
        )}
        <div className="tx-state-actions">
          {t.audioAvailable && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying && <span className="spinner" aria-hidden="true" />}
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          )}
          <Link to="/" className="btn">
            Upload another file
          </Link>
          <DeleteTranscriptButton transcriptId={t.id} title={t.title} label="Delete" />
        </div>
      </div>
    </div>
  );
}
