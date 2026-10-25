// Messages between the page and the speech worker.
import type { QualityMode } from '../../../shared/types';

export interface SpeechJobOptions {
  quality: QualityMode;
  speakersExpected: number | null;
}

export type SpeechStage = 'loading' | 'speakers' | 'transcribing';

export interface SpeechProgress {
  stage: SpeechStage;
  /** Human-readable status, e.g. "Downloading speech model (34 of 80 MB)…". */
  message: string;
  /** Progress of the whole job, 0..1, or null when unknown. */
  fraction: number | null;
}

export interface SpeechSegment {
  /** "S0", "S1", … in order of first appearance. */
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SpeechResult {
  segments: SpeechSegment[];
  languageCode: string | null;
  durationSec: number;
}

export type SpeechErrorCode = 'NO_SPEECH' | 'MODEL_DOWNLOAD' | 'FAILED';

export type WorkerRequest = { type: 'run'; jobId: string; audio: Float32Array; options: SpeechJobOptions };

export type WorkerResponse =
  | ({ type: 'progress'; jobId: string } & SpeechProgress)
  | ({ type: 'result'; jobId: string } & SpeechResult)
  | { type: 'error'; jobId: string; code: SpeechErrorCode; message: string };
