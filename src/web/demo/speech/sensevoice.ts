// SenseVoice-Small (FunAudioLLM; int8 ONNX export by sherpa-onnx), a CTC model that beats Whisper
// Small on Chinese, Cantonese, Japanese and Korean. Served from this site's /models/ folder.
// Placeholder: implemented in a follow-up change.
import type { ByteProgress, Recognizer } from './recognizer';

/** Languages SenseVoice transcribes well (it also does English, where Whisper is used instead). */
export const SENSEVOICE_LANGUAGES = ['zh', 'yue', 'ja', 'ko'] as const;

/** Approximate download size in MB (shown before downloading). */
export const SENSEVOICE_MB = 240;

export async function loadSenseVoice(_onProgress: ByteProgress): Promise<Recognizer> {
  throw new Error('SenseVoice is not available in this build');
}
