// Types shared by the server and the web client. This file is the API contract:
// every request/response shape that crosses the network is defined here.

/** Audio container formats the app accepts. */
export const ACCEPTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm'] as const;
export type AcceptedExtension = (typeof ACCEPTED_EXTENSIONS)[number];

/** MIME types browsers commonly report for the accepted formats (used for the file picker `accept`). */
export const ACCEPTED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'application/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'video/webm',
] as const;

export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export type ProviderName = 'assemblyai' | 'deepgram' | 'mock';

/**
 * Transcription quality, chosen per upload (see src/shared/quality.ts for what each does).
 * "ultra" is limited to a number of free uses per client per day.
 */
export const QUALITY_MODES = ['standard', 'high', 'ultra'] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];

/**
 * Lifecycle of a transcript job on the server. "Uploading" is a client-only stage
 * (the record is created once the upload has fully arrived).
 *   queued       -> waiting for a worker slot
 *   transcribing -> audio sent to the speech-to-text provider, waiting for the result
 *   separating   -> building speaker rows from the provider result
 *   done         -> document available
 *   error        -> failed; see `error`
 */
export type TranscriptStatus = 'queued' | 'transcribing' | 'separating' | 'done' | 'error';

/** Stages shown in the UI stepper, in order. */
export type ProcessingStage = 'uploading' | 'transcribing' | 'separating' | 'done';

export interface Speaker {
  /** Stable id, e.g. "spk_1". Never shown to users. */
  id: string;
  /** Display name, e.g. "Speaker 1" or "Interviewer". Renaming changes only this field. */
  name: string;
  /** Index into the speaker colour palette; assigned once and never changes on rename. */
  colorIndex: number;
}

export interface TranscriptRow {
  /** Stable id, e.g. "row_ab12cd". */
  id: string;
  speakerId: string;
  /** Milliseconds from the start of the audio. Integers. */
  startMs: number;
  endMs: number;
  text: string;
}

/** The editable part of a transcript. Rows are kept in chronological order. */
export interface TranscriptDocument {
  /** Incremented by the server on every successful save (optimistic concurrency). */
  version: number;
  speakers: Speaker[];
  rows: TranscriptRow[];
}

export interface TranscriptError {
  code: ErrorCode;
  /** Human-readable, safe to show to end users. */
  message: string;
  /** Optional extra detail (e.g. the provider's own message). */
  detail?: string;
}

export interface TranscriptProgress {
  stage: TranscriptStatus;
  /** ISO timestamp when the current job attempt started processing (null while queued). */
  startedAt: string | null;
  /** Seconds since `startedAt`. */
  elapsedSeconds: number;
  /** Estimated seconds until done; null if unknown. Never negative. */
  etaSeconds: number | null;
  /** Estimated total processing seconds for this file (not counting the queue wait). */
  estimatedTotalSeconds: number | null;
  /** 1-based position in the queue while status is "queued"; null otherwise. */
  queuePosition: number | null;
  /** Finer-grained status text, e.g. "Downloading speech model (12 of 77 MB)…" (in-browser engine). */
  message?: string | null;
  /** Measured progress 0..1, when known (in-browser engine). */
  fraction?: number | null;
}

/** Shape used in the history list. */
export interface TranscriptSummary {
  id: string;
  /** Defaults to the original file name without extension; user-editable. */
  title: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  /** Audio duration in seconds, if known. */
  durationSec: number | null;
  status: TranscriptStatus;
  provider: ProviderName;
  /** Quality mode the file was (or is being) transcribed with. */
  quality: QualityMode;
  /** BCP-47-ish language code detected by the provider, e.g. "en", "es", "en_us". */
  languageCode: string | null;
  speakersExpected: number | null;
  speakerCount: number | null;
  rowCount: number | null;
  keepAudio: boolean;
  /** True while the server still has the audio file (playback via /audio is possible). */
  audioAvailable: boolean;
  error: TranscriptError | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TranscriptDetail extends TranscriptSummary {
  progress: TranscriptProgress;
  /** Present only when status === "done". */
  document: TranscriptDocument | null;
}

// ---------------------------------------------------------------------------
// REST API (all JSON unless noted). Errors always use ApiErrorBody.
// ---------------------------------------------------------------------------

/** GET /api/config */
export interface AppConfigResponse {
  provider: ProviderName | null;
  providerConfigured: boolean;
  maxUploadBytes: number;
  acceptedExtensions: readonly AcceptedExtension[];
  /** Whether the provider can use "number of speakers" as a hint. */
  supportsSpeakerCount: boolean;
  maxSpeakers: number;
  /** Static demo build (no server): transcription runs in the browser (see src/web/demo). */
  demoMode?: boolean;
  /** Quality modes in display order, with their free daily limits. */
  qualityModes: QualityModeInfo[];
  defaultQuality: QualityMode;
}

export interface QualityModeInfo {
  id: QualityMode;
  /** "Standard", "High", "Ultra High" */
  label: string;
  /** One line, e.g. "Fast, for clear recordings". */
  tagline: string;
  /** What the mode does, for a tooltip or details panel. */
  description: string;
  /** Relative ratings 1–5 for meters in the UI. */
  speed: number;
  accuracy: number;
  /** Free uses per client per day; null = unlimited. */
  dailyLimit: number | null;
}

/** GET /api/usage — the requesting client's usage of limited quality modes today. */
export interface UsageResponse {
  /** UTC day the counts apply to, "YYYY-MM-DD". */
  day: string;
  /** ISO timestamp when the daily limits reset (next UTC midnight). */
  resetsAt: string;
  modes: Record<QualityMode, ModeUsage>;
}

export interface ModeUsage {
  /** Uses counted today (finished jobs plus jobs still processing). */
  used: number;
  limit: number | null;
  /** null when unlimited. */
  remaining: number | null;
}

/**
 * POST /api/transcripts   (multipart/form-data)
 *   fields (send BEFORE the file part): speakersExpected?: "1".."maxSpeakers", keepAudio?: "true"|"false",
 *                                        clientDurationSec?: number as string,
 *                                        quality?: "standard"|"high"|"ultra" (default "high";
 *                                        429 QUOTA_EXCEEDED when the daily limit is used up)
 *   file part name: "file"
 * -> 201 CreateTranscriptResponse
 */
export interface CreateTranscriptResponse {
  transcript: TranscriptSummary;
}

/** GET /api/transcripts -> newest first */
export interface ListTranscriptsResponse {
  transcripts: TranscriptSummary[];
}

/** GET /api/transcripts/:id */
export interface GetTranscriptResponse {
  transcript: TranscriptDetail;
}

/** PUT /api/transcripts/:id/document  body: SaveDocumentRequest -> 200 SaveDocumentResponse | 409 VersionConflictBody */
export interface SaveDocumentRequest {
  /** The version the client's edits are based on. */
  baseVersion: number;
  speakers: Speaker[];
  rows: TranscriptRow[];
}
export interface SaveDocumentResponse {
  document: TranscriptDocument;
}
export interface VersionConflictBody extends ApiErrorBody {
  document: TranscriptDocument;
}

/** PATCH /api/transcripts/:id  body -> 200 { transcript: TranscriptSummary } */
export interface UpdateTranscriptRequest {
  title?: string;
}
export interface UpdateTranscriptResponse {
  transcript: TranscriptSummary;
}

/**
 * Other endpoints:
 *   DELETE /api/transcripts/:id          -> 204 (deletes record + any stored audio; cancels processing)
 *   DELETE /api/transcripts/:id/audio    -> 200 { transcript: TranscriptSummary }
 *   POST   /api/transcripts/:id/retry    -> 200 { transcript: TranscriptSummary } (only status=error and audio available)
 *   GET    /api/transcripts/:id/audio    -> audio bytes, supports HTTP Range; 404 AUDIO_DELETED when gone
 *   GET    /api/transcripts/:id/export?format=csv|xlsx|txt|srt|docx -> file download (attachment)
 *   GET    /api/health                   -> 200 { ok: true }
 */
export const EXPORT_FORMATS = ['csv', 'xlsx', 'txt', 'srt', 'docx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'NO_FILE',
  'UNSUPPORTED_FILE',
  'FILE_TOO_LARGE',
  'EMPTY_FILE',
  'UNREADABLE_AUDIO',
  'UPLOAD_ABORTED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'NOT_READY',
  'AUDIO_DELETED',
  'VERSION_CONFLICT',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_AUTH_FAILED',
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_TIMEOUT',
  'NO_SPEECH',
  'CANNOT_RETRY',
  'QUOTA_EXCEEDED',
  'UNAUTHORIZED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    detail?: string;
  };
}
