import { formatBytes, formatDuration, formatEta } from '../../shared/time';
import type { TranscriptError, TranscriptProgress, TranscriptStatus } from '../../shared/types';
import './processing-steps.css';

export interface ProcessingStepsProps {
  /** Current stage. "queued" is shown as the start of the Transcribing step ("Waiting in queue…"). */
  stage: 'uploading' | TranscriptStatus;
  /** While uploading: bytes sent so far and an ETA computed from the upload speed. */
  upload?: { loaded: number; total: number; etaSeconds: number | null };
  /** Server progress (queue position, ETA) once the upload is done. */
  progress?: TranscriptProgress | null;
  fileName?: string;
  durationSec?: number | null;
  error?: TranscriptError | null;
}

const STEPS = ['Uploading', 'Transcribing', 'Separating speakers', 'Done'] as const;

function stepIndex(stage: ProcessingStepsProps['stage']): number {
  switch (stage) {
    case 'uploading':
      return 0;
    case 'queued':
    case 'transcribing':
    case 'error':
      return 1;
    case 'separating':
      return 2;
    case 'done':
      return 3;
  }
}

/** Status line for the current stage, e.g. "Transcribing — about 2 minutes remaining". */
export function stageDetail({ stage, upload, progress }: ProcessingStepsProps): string {
  switch (stage) {
    case 'uploading': {
      if (!upload || upload.total <= 0) return 'Uploading…';
      const pct = Math.floor((upload.loaded / upload.total) * 100);
      const eta = upload.etaSeconds != null ? ` · ${formatEta(upload.etaSeconds)} remaining` : '';
      return `Uploading ${pct}% · ${formatBytes(upload.loaded)} of ${formatBytes(upload.total)}${eta}`;
    }
    case 'queued':
      return progress?.queuePosition && progress.queuePosition > 1
        ? `Waiting in queue (position ${progress.queuePosition})…`
        : 'Waiting for a free transcription slot…';
    case 'transcribing':
      if (progress?.message) {
        // The in-browser engine reports what it is doing (downloading models, finding speakers…).
        const eta = progress.etaSeconds ? ` · ${formatEta(progress.etaSeconds)} remaining` : '';
        return `${progress.message}${eta}`;
      }
      if (progress?.etaSeconds === 0) return 'Transcribing — taking longer than expected…';
      return progress?.etaSeconds != null
        ? `Transcribing — ${formatEta(progress.etaSeconds)} remaining`
        : 'Transcribing…';
    case 'separating':
      return 'Separating speakers…';
    case 'done':
      return 'Done! Your transcript is ready.';
    case 'error':
      return 'Processing stopped.';
  }
}

/** 0..1 progress for the bar, or null for an indeterminate bar. */
function fraction({ stage, upload, progress }: ProcessingStepsProps): number | null {
  if (stage === 'uploading') return upload && upload.total > 0 ? upload.loaded / upload.total : null;
  if (stage === 'done') return 1;
  if (stage === 'transcribing' && progress?.fraction != null) return Math.min(0.99, progress.fraction);
  if (stage === 'transcribing' && progress?.estimatedTotalSeconds) {
    return Math.min(0.95, progress.elapsedSeconds / progress.estimatedTotalSeconds);
  }
  return null;
}

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Uploading → Transcribing → Separating speakers → Done, with the current stage's detail and ETA. */
export default function ProcessingSteps(props: ProcessingStepsProps) {
  const { stage, fileName, durationSec, error } = props;
  const current = stepIndex(stage);
  const failed = stage === 'error';
  const done = stage === 'done';
  const value = fraction(props);

  return (
    <div className={`steps${failed ? ' steps-failed' : ''}`} data-stage={stage}>
      {(fileName || durationSec != null) && (
        <p className="steps-file">
          {fileName && <strong>{fileName}</strong>}
          {durationSec != null && <span> · {formatDuration(durationSec)}</span>}
        </p>
      )}
      <ol className="steps-list">
        {STEPS.map((label, i) => {
          const state =
            done || i < current ? 'complete' : i === current ? (failed ? 'failed' : 'current') : 'upcoming';
          return (
            <li
              key={label}
              className={`steps-item steps-${state}`}
              aria-current={state === 'current' || state === 'failed' ? 'step' : undefined}
            >
              <span className="steps-marker" aria-hidden="true">
                {state === 'complete' ? <CheckMark /> : state === 'failed' ? <Cross /> : i + 1}
              </span>
              <span className="steps-label">
                {label}
                <span className="visually-hidden">
                  {state === 'complete'
                    ? ' (done)'
                    : state === 'current'
                      ? ' (in progress)'
                      : state === 'failed'
                        ? ' (failed)'
                        : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {!failed && !done && (
        <div
          className={`steps-bar${value == null ? ' steps-bar-indeterminate' : ''}`}
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value == null ? undefined : Math.round(value * 100)}
        >
          <span style={value == null ? undefined : { width: `${Math.max(2, value * 100)}%` }} />
        </div>
      )}
      <p className="steps-detail" role="status" aria-live="polite">
        {failed && error ? error.message : stageDetail(props)}
      </p>
    </div>
  );
}
