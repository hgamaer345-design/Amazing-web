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
  /**
   * Segments shorter than this (seconds) that mostly overlap another speaker are dropped: their
   * clip mostly holds the other voice, so Whisper would repeat that speaker's words or invent some.
   */
  minOverlapped?: number;
}

/**
 * Speaker turns in time order. Consecutive segments of the same speaker with a short pause
 * between them become one clip (more context for Whisper, fewer model runs); overlapping
 * speech from different speakers yields separate, overlapping clips, except for brief
 * interjections inside someone else's speech (see `minOverlapped`).
 */
export function planTurns(
  segments: DiarizationSegment[],
  numSamples: number,
  opts: TurnOptions = {},
): Turn[] {
  const sr = opts.sampleRate ?? 16000;
  const padding = Math.round((opts.padding ?? 0.15) * sr);
  const joinGap = (opts.joinGap ?? 1.5) * sr;
  const minOverlapped = opts.minOverlapped ?? 1;
  const sorted = segments
    .filter((seg) => {
      const length = seg.end - seg.start;
      if (length >= minOverlapped) return true;
      const overlapped = segments.reduce(
        (most, other) =>
          other.speaker === seg.speaker
            ? most
            : Math.max(most, Math.min(seg.end, other.end) - Math.max(seg.start, other.start)),
        0,
      );
      return overlapped < length / 2;
    })
    .sort((a, b) => a.start - b.start);
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

/**
 * Up to `maxSeconds` of speech for language detection, taken in `pieces` equal parts from the
 * start, the middle and the end of the turns' speech rather than all from the start: a recording
 * often opens with music, a jingle or a name that says little about the language (a French news
 * programme whose first 30 s are music was detected as English). Same as `speechSample` when
 * there is no more speech than that.
 */
export function spreadSample(
  audio: Float32Array,
  turns: Turn[],
  maxSeconds = 30,
  pieces = 3,
  sampleRate = 16000,
): Float32Array {
  const total = turns.reduce((n, t) => n + (t.end - t.start), 0);
  const limit = maxSeconds * sampleRate;
  if (total <= limit || pieces < 2) return speechSample(audio, turns, maxSeconds, sampleRate);
  const piece = Math.floor(limit / pieces);
  const out = new Float32Array(piece * pieces);
  for (let k = 0; k < pieces; k++) {
    // Offsets into the speech with the turns laid end to end.
    let from = Math.round((k * (total - piece)) / (pieces - 1));
    let pos = k * piece;
    const end = pos + piece;
    for (const t of turns) {
      const length = t.end - t.start;
      if (from >= length) {
        from -= length;
        continue;
      }
      const take = Math.min(length - from, end - pos);
      out.set(audio.subarray(t.start + from, t.start + from + take), pos);
      pos += take;
      from = 0;
      if (pos >= end) break;
    }
  }
  return out;
}

/**
 * Splits turns longer than `maxSeconds` (Whisper hears 30 s at a time) into pieces, cutting at
 * the quietest moment in the last `searchSeconds` before each limit so words aren't cut in half.
 * Pieces keep their speaker; the rows are merged again when the document is built.
 */
export function splitLongTurns(
  audio: Float32Array,
  turns: Turn[],
  opts: { maxSeconds?: number; searchSeconds?: number; sampleRate?: number } = {},
): Turn[] {
  const sr = opts.sampleRate ?? 16000;
  const max = Math.round((opts.maxSeconds ?? 28) * sr);
  const search = Math.round((opts.searchSeconds ?? 4) * sr);
  const frame = Math.round(0.05 * sr);
  const hop = Math.round(0.01 * sr);
  const out: Turn[] = [];
  for (const turn of turns) {
    let start = turn.start;
    while (turn.end - start > max) {
      let cut = start + max;
      let quietest = Number.POSITIVE_INFINITY;
      for (let at = start + max - search; at + frame <= start + max; at += hop) {
        let energy = 0;
        for (let k = at; k < at + frame; k++) energy += audio[k]! * audio[k]!;
        if (energy < quietest) {
          quietest = energy;
          cut = at + Math.floor(frame / 2);
        }
      }
      out.push({ speaker: turn.speaker, start, end: cut });
      start = cut;
    }
    out.push({ speaker: turn.speaker, start, end: turn.end });
  }
  return out;
}
