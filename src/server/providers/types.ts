import type { ProviderName, QualityMode } from '../../shared/types';

/** One diarized chunk of speech as returned by a provider (an utterance, paragraph or sentence). */
export interface ProviderSegment {
  /** The provider's raw speaker label ("A", "B", "0", "1", …), or null if unknown. */
  speaker: string | null;
  /** Milliseconds from the start of the audio (integers). */
  startMs: number;
  endMs: number;
  text: string;
}

export interface ProviderResult {
  segments: ProviderSegment[];
  /** Detected language code as reported by the provider, e.g. "en", "en_us", "es". */
  languageCode: string | null;
  /** Audio duration reported by the provider, if any. */
  durationSec: number | null;
  /**
   * Word-level results with per-word speaker labels, when the provider returns them. Used by the
   * Ultra High mode to split rows exactly where the speaker changes.
   */
  words?: ProviderSegment[];
}

export interface TranscribeRequest {
  /** Absolute path of the stored audio file. */
  audioPath: string;
  mimeType: string;
  sizeBytes: number;
  /** User's hint for the number of speakers; null = auto-detect. */
  speakersExpected: number | null;
  /** Quality mode; selects the provider model. Defaults to "high". */
  quality?: QualityMode;
  /** Language the user chose (a WHISPER_LANGUAGES code, e.g. "fr"); null/absent = detect it. */
  language?: string | null;
  /** Aborted when the job is deleted, the lease is lost, the job times out or the server shuts down. */
  signal: AbortSignal;
  /**
   * Called as soon as the provider assigns an async job id (before waiting for the result),
   * so the worker can persist it and resume polling after a restart.
   */
  onJobCreated(providerJobId: string): void | Promise<void>;
}

export interface TranscriptionProvider {
  readonly name: ProviderName;
  /** Whether `speakersExpected` is honoured. */
  readonly supportsSpeakerCount: boolean;
  /** Upload/submit the audio and wait for the diarized result. */
  transcribe(req: TranscribeRequest): Promise<ProviderResult>;
  /** Resume waiting for a job previously created by `transcribe` (after a restart). Optional. */
  resume?(providerJobId: string, signal: AbortSignal): Promise<ProviderResult>;
  /** Best-effort deletion of the provider's copy of the data. Must not throw. */
  cleanup?(providerJobId: string): Promise<void>;
}

/**
 * Error kinds, which decide what the worker does:
 *   auth       -> fail with PROVIDER_AUTH_FAILED (no retry)
 *   transient  -> retry with backoff (network error, 5xx, 429, timeouts)
 *   no_speech  -> fail with NO_SPEECH
 *   failed     -> fail with TRANSCRIPTION_FAILED (provider rejected/failed the audio; no retry)
 */
export type ProviderErrorKind = 'auth' | 'transient' | 'no_speech' | 'failed';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP status from the provider, if any. */
  readonly status: number | undefined;
  /** Provider's own error text (safe to show as "details"; never contains our API key). */
  readonly detail: string | undefined;
  /** For 429s: how long the provider asked us to wait. */
  readonly retryAfterMs: number | undefined;
  /**
   * For transient errors: true if the provider-side job is still valid and polling can
   * resume with the same job id (e.g. a network blip while polling).
   */
  readonly jobStillValid: boolean;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      status?: number;
      detail?: string;
      retryAfterMs?: number;
      jobStillValid?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.detail = options.detail;
    this.retryAfterMs = options.retryAfterMs;
    this.jobStillValid = options.jobStillValid ?? false;
  }
}
