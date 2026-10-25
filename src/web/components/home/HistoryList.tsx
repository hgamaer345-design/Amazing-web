import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ERROR_MESSAGES } from '../../../shared/errors';
import { QUALITY_MODE_DEFINITIONS } from '../../../shared/quality';
import { formatDuration } from '../../../shared/time';
import type { TranscriptStatus, TranscriptSummary } from '../../../shared/types';
import { ApiError, listTranscripts } from '../../api';
import { usePolling } from '../../hooks/usePolling';
import { useNow } from '../../hooks/useUsage';
import { formatRelativeTime } from '../../lib/relativeTime';
import { DeleteTranscriptButton } from '../editor/DeleteActions';

type Filter = 'all' | 'done' | 'processing' | 'failed';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' },
  { id: 'processing', label: 'Processing' },
  { id: 'failed', label: 'Failed' },
];

const STATUS_LABEL: Record<TranscriptStatus, string> = {
  queued: 'Queued',
  transcribing: 'Transcribing…',
  separating: 'Separating speakers…',
  done: 'Done',
  error: 'Failed',
};

function isProcessing(t: TranscriptSummary): boolean {
  return t.status === 'queued' || t.status === 'transcribing' || t.status === 'separating';
}

function matches(t: TranscriptSummary, filter: Filter): boolean {
  if (filter === 'done') return t.status === 'done';
  if (filter === 'failed') return t.status === 'error';
  if (filter === 'processing') return isProcessing(t);
  return true;
}

function StatusBadge({ t }: { t: TranscriptSummary }) {
  const cls = t.status === 'done' ? 'badge-success' : t.status === 'error' ? 'badge-danger' : 'badge-info';
  return (
    <span className={`badge ${cls}`}>
      {isProcessing(t) && <span className="spinner badge-spinner" aria-hidden="true" />}
      {STATUS_LABEL[t.status]}
    </span>
  );
}

function HistoryCard({ t, now, onDeleted }: { t: TranscriptSummary; now: number; onDeleted: () => void }) {
  const quality = QUALITY_MODE_DEFINITIONS[t.quality ?? 'high'];
  const meta = [
    formatDuration(t.durationSec),
    t.speakerCount != null ? `${t.speakerCount} ${t.speakerCount === 1 ? 'speaker' : 'speakers'}` : null,
    formatRelativeTime(t.createdAt, now),
  ].filter(Boolean);
  return (
    <li className={`history-card status-${t.status}`} data-testid="history-item">
      <Link to={`/t/${t.id}`} className="history-link">
        <span className="history-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="history-body">
          <span className="history-title">{t.title}</span>
          <span className="history-meta">{meta.join(' · ')}</span>
          {t.status === 'error' && t.error && <span className="history-error">{t.error.message}</span>}
        </span>
      </Link>
      <span className="history-badges">
        <StatusBadge t={t} />
        <span className={`badge quality-badge quality-badge-${quality.id}`}>{quality.label}</span>
        {t.audioAvailable && (
          <span className="badge" title="Audio is kept on the server">
            Audio kept
          </span>
        )}
      </span>
      <span className="history-actions">
        <DeleteTranscriptButton
          transcriptId={t.id}
          title={t.title}
          label="Delete"
          className="btn btn-ghost btn-sm history-delete"
          onDeleted={onDeleted}
        />
      </span>
    </li>
  );
}

/** "Your transcripts": search, status filters, auto-refresh while anything is processing. */
export function HistoryList() {
  const searchId = useId();
  const now = useNow(30_000);
  const [items, setItems] = useState<TranscriptSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      setItems(await listTranscripts());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ERROR_MESSAGES.INTERNAL);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const anyProcessing = !!items?.some(isProcessing);
  usePolling({ enabled: anyProcessing, poll: load, delayMs: () => 4000 });

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, done: 0, processing: 0, failed: 0 };
    for (const t of items ?? []) for (const f of FILTERS) if (matches(t, f.id)) c[f.id]++;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (t) =>
        matches(t, filter) &&
        (!q || t.title.toLowerCase().includes(q) || t.originalFilename.toLowerCase().includes(q)),
    );
  }, [items, filter, query]);

  return (
    <section className="history" aria-labelledby="history-heading">
      <div className="history-head">
        <h2 id="history-heading">Your transcripts</h2>
        {items && items.length > 0 && (
          <div className="history-tools">
            <label htmlFor={searchId} className="visually-hidden">
              Search transcripts
            </label>
            <input
              id={searchId}
              type="search"
              className="input history-search"
              placeholder="Search by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="filter-chips" role="group" aria-label="Filter by status">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`filter-chip${filter === f.id ? ' is-active' : ''}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span className="filter-count">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          Couldn’t load your transcripts: {error}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {items == null && !error ? (
        <ul className="history-list" aria-busy="true" aria-label="Loading transcripts">
          {[0, 1, 2].map((i) => (
            <li key={i} className="history-card history-skeleton" aria-hidden="true">
              <span className="skeleton skeleton-icon" />
              <span className="history-body">
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line short" />
              </span>
            </li>
          ))}
        </ul>
      ) : items && items.length === 0 ? (
        <div className="history-empty">
          <span className="history-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="40" height="40">
              <path
                d="M8 14h32M8 24h22M8 34h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <circle cx="36" cy="33" r="6" fill="none" stroke="currentColor" strokeWidth="3" />
            </svg>
          </span>
          <p className="history-empty-title">No transcripts yet</p>
          <p className="field-hint">
            Upload a recording above and it will show up here, ready to reopen any time.
          </p>
        </div>
      ) : (
        items && (
          <>
            {visible.length === 0 ? (
              <p className="history-none">No transcripts match your search.</p>
            ) : (
              <ul className="history-list">
                {visible.map((t) => (
                  <HistoryCard key={t.id} t={t} now={now} onDeleted={() => void load()} />
                ))}
              </ul>
            )}
          </>
        )
      )}
    </section>
  );
}
