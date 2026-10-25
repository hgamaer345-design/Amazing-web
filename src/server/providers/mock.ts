import { parseFile } from 'music-metadata';
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
 * It waits `delayMs`, then returns a deterministic conversation that spans the audio.
 *
 * The worker passes the user's original file name as an extra `originalFilename` property
 * on the request; it is used for test triggers:
 *   - name contains "nospeech" -> no segments (the job ends with NO_SPEECH)
 *   - name contains "fail"     -> a "failed" provider error (TRANSCRIPTION_FAILED)
 */
export type MockTranscribeRequest = TranscribeRequest & { originalFilename?: string };

const SENTENCES = [
  'Thanks for joining me today.',
  'Happy to be here.',
  'Let’s start with how the project began.',
  'It started as a small experiment on a weekend.',
  'We wanted to see whether the idea could work at all.',
  'What surprised you the most in the early days?',
  'Honestly, how quickly people started using it.',
  'We had to rewrite the backend twice in the first month.',
  'That sounds stressful.',
  'It was, but it taught us a lot about planning.',
  'How did you decide what to build next?',
  'We listened to the people who used it every day.',
  'Their feedback shaped almost every feature.',
  'Can you give an example?',
  'Sure, the export feature came straight from a user request.',
  'Where do you see it going from here?',
  'We want to make it faster and easier to share.',
  'And of course to support more languages.',
  'That’s a great place to wrap up.',
  'Thank you so much for your time.',
];

/** Small deterministic PRNG so the same file always gives the same transcript. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

export function generateMockSegments(durationSec: number, speakerCount: number, seed: number): ProviderSegment[] {
  const random = mulberry32(seed);
  const totalMs = Math.max(1000, Math.round(durationSec * 1000));
  const speakers = Math.max(1, Math.min(26, speakerCount));
  const segments: ProviderSegment[] = [];
  let t = Math.min(400, totalMs / 10);
  let speaker = 0;
  let i = 0;
  while (t < totalMs - 200) {
    const text = SENTENCES[i % SENTENCES.length]!;
    const wordCount = text.split(' ').length;
    const length = Math.min(totalMs - t, Math.round(wordCount * (320 + random() * 120)));
    segments.push({
      speaker: String.fromCharCode(65 + speaker),
      startMs: Math.round(t),
      endMs: Math.round(t + length),
      text,
    });
    t += length + 150 + random() * 450;
    i++;
    // Usually hand over to another speaker; sometimes keep talking (exercises row merging).
    if (speakers > 1 && random() > 0.35) speaker = (speaker + 1 + Math.floor(random() * (speakers - 1))) % speakers;
  }
  return segments;
}

export function createMockProvider(opts: { delayMs: number }): TranscriptionProvider {
  return {
    name: 'mock',
    supportsSpeakerCount: true,

    async transcribe(req: MockTranscribeRequest): Promise<ProviderResult> {
      const durationSec = await readDuration(req.audioPath);
      await sleep(opts.delayMs, req.signal);
      const name = (req.originalFilename ?? '').toLowerCase();
      if (name.includes('fail')) {
        throw new ProviderError('failed', 'Mock transcription failed', {
          detail: 'Simulated failure: the file name contains "fail".',
        });
      }
      if (name.includes('nospeech')) return { segments: [], languageCode: null, durationSec };
      const seed = Math.round(durationSec * 1000) ^ req.sizeBytes;
      return {
        segments: generateMockSegments(durationSec, req.speakersExpected ?? 2, seed),
        languageCode: 'en',
        durationSec,
      };
    },
  };
}
