import type { TranscriptError, TranscriptProgress, TranscriptStatus } from '../../shared/types';

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

/** STUB — implemented by the web-home team. */
export default function ProcessingSteps(props: ProcessingStepsProps) {
  return <div>{props.stage}</div>;
}
