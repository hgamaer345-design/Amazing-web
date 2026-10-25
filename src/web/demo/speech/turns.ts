// Turns diarization segments into the audio clips Whisper transcribes: one clip per speaker
// turn, so every row's text comes from that speaker's own audio.
import type { DiarizationSegment } from './diarize';

export interface Turn {
  speaker: number;
  /** Sample range in the 16 kHz audio (end exclusive). */
  start: number;
  end: number;
}

export interface TurnOptions {
  sampleRate?: number;
  /** Context added on both sides so words cut by a diarization boundary are kept (seconds). */
  padding?: number;
  /** Same-speaker segments separated by less than this are one clip (seconds). */
  joinGap?: number;
}

/**
 * Speaker turns in time order. Consecutive segments of the same speaker with a short pause
 * between them become one clip (more context for Whisper, fewer model runs); overlapping
 * speech from different speakers yields separate, overlapping clips.
 */
export function planTurns(
  segments: DiarizationSegment[],
  numSamples: number,
  opts: TurnOptions = {},
): Turn[] {
  const sr = opts.sampleRate ?? 16000;
  const padding = Math.round((opts.padding ?? 0.15) * sr);
  const joinGap = (opts.joinGap ?? 1.5) * sr;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const turns: Turn[] = [];
  for (const seg of sorted) {
    const start = Math.max(0, Math.floor(seg.start * sr) - padding);
    const end = Math.min(numSamples, Math.ceil(seg.end * sr) + padding);
    if (end <= start) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker && start - last.end < joinGap) {
      last.end = Math.max(last.end, end);
    } else {
      turns.push({ speaker: seg.speaker, start, end });
    }
  }
  return turns;
}

/** Up to `maxSeconds` of speech taken from the turns, for language detection. */
export function speechSample(
  audio: Float32Array,
  turns: Turn[],
  maxSeconds = 30,
  sampleRate = 16000,
): Float32Array {
  const limit = maxSeconds * sampleRate;
  const out = new Float32Array(
    Math.min(
      limit,
      turns.reduce((n, t) => n + (t.end - t.start), 0),
    ),
  );
  let pos = 0;
  for (const t of turns) {
    if (pos >= out.length) break;
    const piece = audio.subarray(t.start, Math.min(t.end, t.start + (out.length - pos)));
    out.set(piece, pos);
    pos += piece.length;
  }
  return out;
}
