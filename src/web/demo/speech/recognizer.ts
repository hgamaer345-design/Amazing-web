// The contract every speech-to-text model in the worker meets, so the worker can pick one per
// language: Whisper (any of its 99 languages), SenseVoice (Chinese, Cantonese, Japanese, Korean)
// or Omnilingual ASR (1,600+ languages, for those Whisper handles poorly).

export type { ByteProgress } from './download';

export type RecognizerId = 'whisper-tiny' | 'whisper-base' | 'whisper-small' | 'sensevoice' | 'omnilingual';

/** A loaded model. */
export interface Recognizer {
  id: RecognizerId;
  /** Shown in progress messages, e.g. "Whisper Small", "SenseVoice". */
  label: string;
  /**
   * Text of one clip (16 kHz mono, at most 30 s) spoken in `language` (ISO 639-1, or "yue"),
   * cleaned up; '' when there is nothing usable (silence, noise, a hallucination).
   */
  transcribe(clip: Float32Array, language: string): Promise<string>;
  /** Frees the model's memory (another model can then be loaded on a phone). */
  dispose(): Promise<void>;
}
