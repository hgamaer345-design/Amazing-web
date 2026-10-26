// Meta's Omnilingual ASR 300M (CTC, 1,600+ languages; int8 ONNX export by sherpa-onnx), for
// languages Whisper transcribes poorly. Its text has no punctuation or capital letters. Served
// from this site's /models/ folder.
// Placeholder: implemented in a follow-up change.
import type { ByteProgress, Recognizer } from './recognizer';

/** Approximate download size in MB (shown before downloading). */
export const OMNILINGUAL_MB = 365;

export async function loadOmnilingual(_onProgress: ByteProgress): Promise<Recognizer> {
  throw new Error('Omnilingual ASR is not available in this build');
}
