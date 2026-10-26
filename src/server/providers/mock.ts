import { parseFile } from 'music-metadata';
import { generateMockSegments } from '../../shared/mockTranscript';
import type { QualityMode } from '../../shared/types';
import { sleep } from './http';
import {
  ProviderError,
  type ProviderResult,
  type ProviderSegment,
  type TranscribeRequest,
  type TranscriptionProvider,
} from './types';

/**
 * A fake provider for local development, demos and tests (TRANSCRIPTION_PROVIDER=mock).
 * It waits `delayMs` (scaled by the quality mode), then returns a deterministic conversation
 * that spans the audio.
 *
 * The worker passes the user's original file name as an extra `originalFilename` property
 * on the request; it is used for test triggers:
 *   - name contains "nospeech" -> no segments (the job ends with NO_SPEECH)
 *   - name contains "fail"     -> a "failed" provider error (TRANSCRIPTION_FAILED)
 */
export type MockTranscribeRequest = TranscribeRequest & { originalFilename?: string };

const DELAY_FACTOR: Record<QualityMode, number> = { standard: 0.6, high: 1, ultra: 1.5 };

async function readDuration(path: string): Promise<number> {
  try {
    const meta = await parseFile(path, { duration: true });
    const d = meta.format.duration;
    if (d && Number.isFinite(d) && d > 0) return d;
  } catch {
    // Unreadable: fall through to the default.
  }
  return 60;
}

/** Splits segments into words with evenly spread timings (what a real provider's word list looks like). */
export function mockWords(segments: ProviderSegment[]): ProviderSegment[] {
  return segments.flatMap((seg) => {
    const words = seg.text.split(/\s+/).filter(Boolean);
    const step = (seg.endMs - seg.startMs) / Math.max(1, words.length);
    return words.map((text, i) => ({
      speaker: seg.speaker,
      startMs: Math.round(seg.startMs + i * step),
      endMs: Math.round(seg.startMs + (i + 1) * step),
      text,
    }));
  });
}

export function createMockProvider(opts: { delayMs: number }): TranscriptionProvider {
  return {
    name: 'mock',
    supportsSpeakerCount: true,

    async transcribe(req: MockTranscribeRequest): Promise<ProviderResult> {
      const durationSec = await readDuration(req.audioPath);
      await sleep(Math.round(opts.delayMs * DELAY_FACTOR[req.quality ?? 'high']), req.signal);
      const name = (req.originalFilename ?? '').toLowerCase();
      if (name.includes('fail')) {
        throw new ProviderError('failed', 'Mock transcription failed', {
          detail: 'Simulated failure: the file name contains "fail".',
        });
      }
      if (name.includes('nospeech')) return { segments: [], languageCode: null, durationSec };
      const seed = Math.round(durationSec * 1000) ^ req.sizeBytes;
      const segments = generateMockSegments(durationSec, req.speakersExpected ?? 2, seed);
      // The conversation is always English, but report a chosen language as a real provider would.
      return { segments, words: mockWords(segments), languageCode: req.language ?? 'en', durationSec };
    },
  };
}
