// Speaker diarization ("who spoke when"), ported from sherpa-onnx's reference pipeline for
// pyannote segmentation-3.0:
//   1. run the segmentation model on 10 s windows (powerset output: up to 3 local speakers),
//   2. compute a speaker embedding for each (window, local speaker) with enough speech,
//   3. cluster the embeddings into global speakers (complete linkage, cosine distance),
//   4. re-aggregate the per-window activity into global per-frame activity, keeping as many
//      speakers per frame as the windows say are talking,
//   5. turn frame activity into segments, merging short gaps and dropping very short bits.
// The two neural networks are injected so the algorithm itself is testable without them.
import { clusterEmbeddings } from './cluster';

/** pyannote segmentation-3.0 constants (from the model's metadata). */
export const SEGMENTATION = {
  sampleRate: 16000,
  windowSize: 160000,
  receptiveFieldSize: 991,
  receptiveFieldShift: 270,
  numSpeakers: 3,
  numClasses: 7,
} as const;

export interface DiarizationSegment {
  /** Seconds. */
  start: number;
  end: number;
  speaker: number;
}

export interface DiarizationOptions {
  /** Hop between analysis windows, in samples (the reference uses 10% of the window). */
  windowShift?: number;
  /** Exact number of speakers if known; otherwise clusters are cut at `threshold`. */
  numSpeakers?: number | null;
  threshold?: number;
  minDurationOn?: number;
  minDurationOff?: number;
}

export interface DiarizationModels {
  /** Segmentation logits for each window: an array of (frames × 7) row-major matrices. */
  segment(windows: Float32Array[]): Promise<Float32Array[]>;
  /** Speaker embedding for a stretch of 16 kHz audio. */
  embed(samples: Float32Array): Promise<Float32Array>;
}

/** Powerset class -> active local speakers: {}, {0}, {1}, {2}, {0,1}, {0,2}, {1,2}. */
const POWERSET: readonly (readonly number[])[] = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

/** Per-window, per-frame binary activity of the 3 local speakers: [window][frame][speaker]. */
type Labels = Uint8Array[][];

function toMultiLabel(logits: Float32Array, numClasses: number): Uint8Array[] {
  const frames = logits.length / numClasses;
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    let best = 0;
    for (let c = 1; c < numClasses; c++) {
      if (logits[f * numClasses + c]! > logits[f * numClasses + best]!) best = c;
    }
    const row = new Uint8Array(SEGMENTATION.numSpeakers);
    for (const s of POWERSET[best]!) row[s] = 1;
    out.push(row);
  }
  return out;
}

/** Splits audio into windows the way the reference does (including a zero-padded tail window). */
export function makeWindows(audio: Float32Array, windowSize: number, windowShift: number) {
  const n = audio.length;
  const full = n >= windowSize ? Math.floor((n - windowSize) / windowShift) + 1 : 0;
  const hasLast = n < windowSize || (n - windowSize) % windowShift > 0;
  const starts = Array.from({ length: full }, (_, i) => i * windowShift);
  if (hasLast) starts.push(full * windowShift);
  return { starts, hasLast };
}

function windowAt(audio: Float32Array, start: number, windowSize: number): Float32Array {
  if (start + windowSize <= audio.length) return audio.subarray(start, start + windowSize);
  const padded = new Float32Array(windowSize);
  padded.set(audio.subarray(start));
  return padded;
}

function totalFrames(numWindows: number, windowShift: number): number {
  return (
    Math.floor(
      (SEGMENTATION.windowSize + (numWindows - 1) * windowShift) / SEGMENTATION.receptiveFieldShift,
    ) + 1
  );
}

function frameOffset(window: number, windowShift: number): number {
  return Math.floor((window * windowShift) / SEGMENTATION.receptiveFieldShift + 0.5);
}

/** How many speakers are talking in each global frame (rounded average over windows). */
function speakerCount(labels: Labels, windowShift: number): Int8Array {
  const frames = totalFrames(labels.length, windowShift);
  const sum = new Float64Array(frames);
  const count = new Float64Array(frames);
  labels.forEach((win, i) => {
    const start = frameOffset(i, windowShift);
    win.forEach((row, f) => {
      if (start + f >= frames) return;
      sum[start + f]! += row[0]! + row[1]! + row[2]!;
      count[start + f]! += 1;
    });
  });
  return Int8Array.from(sum, (s, f) => Math.floor(s / Math.max(count[f]!, 1e-12) + 0.5));
}

/** Audio of local speaker `j` in window `i` (its active frames concatenated). */
function speakerAudio(audio: Float32Array, frames: Uint8Array[], j: number, offset: number): Float32Array {
  const numFrames = frames.length;
  const { windowSize } = SEGMENTATION;
  const pieces: Float32Array[] = [];
  let start: number | null = null;
  const take = (from: number, to: number) => {
    const a = Math.floor((from / numFrames) * windowSize) + offset;
    const b = Math.min(audio.length, Math.floor((to / numFrames) * windowSize) + offset);
    if (b > a) pieces.push(audio.subarray(a, b));
  };
  for (let k = 0; k < numFrames; k++) {
    if (frames[k]![j]) {
      if (start === null) start = k;
    } else if (start !== null) {
      take(start, k);
      start = null;
    }
  }
  if (start !== null) take(start, numFrames - 1);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const p of pieces) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Frame activity of each global speaker -> merged, filtered segments. */
function toSegments(
  final: Uint8Array[],
  numSpeakers: number,
  minOn: number,
  minOff: number,
): DiarizationSegment[] {
  const scale = SEGMENTATION.receptiveFieldShift / SEGMENTATION.sampleRate;
  const offset = (SEGMENTATION.receptiveFieldSize / SEGMENTATION.sampleRate) * 0.5;
  const out: DiarizationSegment[] = [];
  for (let s = 0; s < numSpeakers; s++) {
    const segs: DiarizationSegment[] = [];
    let start: number | null = final[0]?.[s] ? 0 : null;
    for (let f = 1; f < final.length; f++) {
      const on = final[f]![s] === 1;
      if (start !== null && !on) {
        segs.push({ start: start * scale + offset, end: f * scale + offset, speaker: s });
        start = null;
      } else if (start === null && on) start = f;
    }
    if (start !== null)
      segs.push({ start: start * scale + offset, end: (final.length - 1) * scale + offset, speaker: s });
    // Merge segments separated by short pauses, then drop blips.
    const merged: DiarizationSegment[] = [];
    for (const seg of segs) {
      const last = merged[merged.length - 1];
      if (last && seg.start - last.end <= minOff) last.end = seg.end;
      else merged.push({ ...seg });
    }
    out.push(...merged.filter((seg) => seg.end - seg.start >= minOn && seg.end > seg.start));
  }
  return out.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
}

/**
 * Who spoke when. `onProgress` receives 0..1 (segmentation ≈ first 30%, embeddings the rest).
 * Speaker numbers are 0-based and assigned in order of first appearance.
 */
export async function diarize(
  audio: Float32Array,
  models: DiarizationModels,
  options: DiarizationOptions = {},
  onProgress?: (fraction: number) => void,
): Promise<DiarizationSegment[]> {
  const { windowSize, numClasses, numSpeakers: localSpeakers } = SEGMENTATION;
  const windowShift = options.windowShift ?? windowSize / 10;
  const { starts, hasLast } = makeWindows(audio, windowSize, windowShift);
  if (starts.length === 0) return [];

  // 1. Segmentation, a few windows at a time.
  const labels: Labels = [];
  const batch = 8;
  for (let i = 0; i < starts.length; i += batch) {
    const windows = starts.slice(i, i + batch).map((s) => windowAt(audio, s, windowSize));
    const logits = await models.segment(windows);
    for (const l of logits) labels.push(toMultiLabel(l, numClasses));
    onProgress?.(0.3 * Math.min(1, (i + batch) / starts.length));
  }

  const perFrame = speakerCount(labels, windowShift);
  if (!perFrame.some((c) => c > 0)) return [];

  // 2. Embeddings for each local speaker with at least ~0.2 s of speech in its window.
  const pairs: { window: number; speaker: number }[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < localSpeakers; j++) {
      let active = 0;
      for (const row of labels[i]!) active += row[j]!;
      if (active >= 10) pairs.push({ window: i, speaker: j });
    }
  }
  if (pairs.length === 0) return [];
  const embeddings: Float32Array[] = [];
  for (let p = 0; p < pairs.length; p++) {
    const { window, speaker } = pairs[p]!;
    embeddings.push(await models.embed(speakerAudio(audio, labels[window]!, speaker, starts[window]!)));
    onProgress?.(0.3 + 0.65 * ((p + 1) / pairs.length));
  }

  // 3. Global speakers.
  const clusters = clusterEmbeddings(embeddings, {
    numClusters: options.numSpeakers ?? null,
    threshold: options.threshold ?? 0.5,
  });
  const globalCount = Math.max(...clusters) + 1;
  const toGlobal = new Map<string, number>();
  pairs.forEach((p, idx) => toGlobal.set(`${p.window}:${p.speaker}`, clusters[idx]!));

  // 4. Aggregate global activity over overlapping windows.
  let frames = totalFrames(labels.length, windowShift);
  const activity = Array.from({ length: frames }, () => new Float64Array(globalCount));
  labels.forEach((win, i) => {
    const start = frameOffset(i, windowShift);
    win.forEach((row, f) => {
      if (start + f >= frames) return;
      for (let j = 0; j < localSpeakers; j++) {
        const g = toGlobal.get(`${i}:${j}`);
        if (g !== undefined && row[j]) activity[start + f]![g]! += 1;
      }
    });
  });
  if (hasLast) frames = Math.min(frames, Math.floor(audio.length / SEGMENTATION.receptiveFieldShift));

  const final: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const row = new Uint8Array(globalCount);
    const speakers = Math.min(perFrame[f] ?? 0, globalCount);
    if (speakers > 0) {
      const order = Array.from(activity[f]!, (v, g) => [v, g] as const).sort(
        (a, b) => b[0] - a[0] || a[1] - b[1],
      );
      for (let k = 0; k < speakers; k++) row[order[k]![1]] = 1;
    }
    final.push(row);
  }

  // 5. Segments, with speakers renumbered by first appearance.
  const segments = toSegments(
    final,
    globalCount,
    options.minDurationOn ?? 0.3,
    options.minDurationOff ?? 0.5,
  );
  const renumber = new Map<number, number>();
  for (const s of segments) if (!renumber.has(s.speaker)) renumber.set(s.speaker, renumber.size);
  onProgress?.(1);
  return segments.map((s) => ({ ...s, speaker: renumber.get(s.speaker)! }));
}
