// Speaker diarization ("who spoke when"), ported from sherpa-onnx's reference pipeline for
// pyannote segmentation-3.0:
//   1. run the segmentation model on 10 s windows (powerset output: up to 3 local speakers),
//   2. compute a speaker embedding for each (window, local speaker) with enough speech,
//   3. cluster the embeddings into global speakers (Ward linkage, then small clusters are folded
//      into the nearest voice and every embedding goes to the closest average voice; short
//      recordings use complete linkage on cosine distance, as the reference does),
//   4. re-aggregate the per-window activity into global per-frame activity, keeping as many
//      speakers per frame as the windows say are talking,
//   5. turn frame activity into segments, merging short gaps and dropping very short bits.
// The two neural networks are injected so the algorithm itself is testable without them.
import { clusterEmbeddings, refineClusters } from './cluster';

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
  /**
   * Ward merge height up to which clusters are joined (unit-length embeddings). By default it
   * grows with the number of embeddings up to 2.45: a merge's height grows with the size of the
   * two groups, so few embeddings need a lower bar to tell voices apart.
   */
  threshold?: number;
  /** Complete-linkage cosine distance used instead for short recordings (see cannotLinkMaxWindows). */
  shortThreshold?: number;
  /**
   * A speaker needs at least this much speech (seconds); less is folded into the nearest voice.
   * Default: 8 s, or a tenth of all speech in short recordings.
   */
  minSpeakerSeconds?: number;
  /** Speakers whose average voices are at least this similar (cosine) are merged. */
  mergeSimilarity?: number;
  minDurationOn?: number;
  minDurationOff?: number;
  /**
   * Spacing, in samples, of the windows that get their own speaker embeddings. Speakers in the
   * windows in between are matched to an overlapping embedded window by when they talk (the
   * windows share most of their audio), which saves most of the embedding work on long files.
   * Unmatched speakers still get an embedding. 0 or unset = embed every window (the reference).
   */
  embedStride?: number;
  /** Windows segmented per model run (fewer use less memory). */
  segmentBatch?: number;
  /** Up to this many windows, local speakers of one window are never clustered together. */
  cannotLinkMaxWindows?: number;
  /** Least speech (seconds) a local speaker needs in a window to get its own embedding. */
  minEmbedSpeech?: number;
  /** Least activity agreement (intersection over union, 0..1) to reuse a neighbour's speaker. */
  linkThreshold?: number;
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
  const batch = options.segmentBatch ?? 8;
  for (let i = 0; i < starts.length; i += batch) {
    const windows = starts.slice(i, i + batch).map((s) => windowAt(audio, s, windowSize));
    const logits = await models.segment(windows);
    for (const l of logits) labels.push(toMultiLabel(l, numClasses));
    onProgress?.(0.3 * Math.min(1, (i + batch) / starts.length));
  }

  const perFrame = speakerCount(labels, windowShift);
  if (!perFrame.some((c) => c > 0)) return [];

  const framesPerWindow = labels[0]!.length;
  const frameSeconds = windowSize / framesPerWindow / SEGMENTATION.sampleRate;
  const minActive = 10;
  const countActive = (win: Uint8Array[], j: number) => win.reduce((n, row) => n + row[j]!, 0);
  const toGlobal = new Map<string, number>();
  let globalCount: number;

  if (labels.length === 1 && !options.numSpeakers) {
    // A single window: the segmentation model has already told its speakers apart, more reliably
    // than embeddings of a few seconds each could (as the reference implementation does).
    globalCount = 0;
    for (let j = 0; j < localSpeakers; j++) {
      if (countActive(labels[0]!, j) >= minActive) toGlobal.set(`0:${j}`, globalCount++);
    }
    if (globalCount === 0) return [];
  } else {
    // 2. Speaker embeddings, from frames where only that speaker talks (overlapped speech would
    //    mix two voices). An embedding of a fraction of a second is unreliable (two such samples
    //    of one voice can be as far apart as two different voices), so only local speakers with
    //    at least `minEmbedSpeech` of clean speech get one. With `embedStride`, only "anchor"
    //    windows are embedded; other windows (and anchors' short speakers) take the speaker of an
    //    overlapping anchor whose activity agrees with theirs over the audio the windows share.
    const clean: Labels = labels.map((win) =>
      win.map((row) => (row[0]! + row[1]! + row[2]! > 1 ? new Uint8Array(localSpeakers) : row)),
    );
    const minEmbedFrames = Math.max(minActive, Math.round((options.minEmbedSpeech ?? 1) / frameSeconds));
    const cleanFrames = clean.map((win) =>
      Array.from({ length: localSpeakers }, (_, j) => countActive(win, j)),
    );
    const anchorEvery = options.embedStride ? Math.max(1, Math.round(options.embedStride / windowShift)) : 1;
    const isAnchor = (i: number) => i % anchorEvery === 0 || i === labels.length - 1;
    const pairs: { window: number; speaker: number }[] = [];
    const pairIndex = new Map<string, number>();
    const addPair = (i: number, j: number) => {
      pairIndex.set(`${i}:${j}`, pairs.length);
      pairs.push({ window: i, speaker: j });
    };
    for (let i = 0; i < labels.length; i += 1) {
      if (!isAnchor(i)) continue;
      for (let j = 0; j < localSpeakers; j++) if (cleanFrames[i]![j]! >= minEmbedFrames) addPair(i, j);
    }
    // Every local speaker that talks at all but has no embedding of its own yet.
    const pending: [number, number][] = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = 0; j < localSpeakers; j++) {
        if (countActive(labels[i]!, j) >= minActive && !pairIndex.has(`${i}:${j}`)) pending.push([i, j]);
      }
    }
    if (pairs.length === 0) {
      // Only short bursts of speech: embed them anyway rather than finding no one.
      for (const [i, j] of pending) if (cleanFrames[i]![j]! >= minActive) addPair(i, j);
      pending.length = 0;
    }
    /** (window:speaker) -> the embedded pair it was matched to. */
    const linked = new Map<string, number>();
    const linkThreshold = options.linkThreshold ?? 0.5;
    const reach = Math.ceil(windowSize / windowShift) - 1; // windows further apart don't overlap
    for (const [i, j] of pending) {
      let best = { score: 0, pair: -1 };
      for (let a = Math.max(0, i - reach); a <= Math.min(labels.length - 1, i + reach); a++) {
        if (a === i || !isAnchor(a)) continue;
        // Global frame g is frame g - offset(i) of window i and g - offset(a) of window a.
        const shift = frameOffset(i, windowShift) - frameOffset(a, windowShift);
        for (let k = 0; k < localSpeakers; k++) {
          const pair = pairIndex.get(`${a}:${k}`);
          if (pair === undefined) continue;
          let both = 0;
          let either = 0;
          for (let f = Math.max(0, -shift); f < Math.min(framesPerWindow, framesPerWindow - shift); f++) {
            const x = labels[i]![f]![j]!;
            const y = labels[a]![f + shift]![k]!;
            both += x & y;
            either += x | y;
          }
          const score = both >= minActive ? both / either : 0;
          if (score > best.score) best = { score, pair };
        }
      }
      if (best.score >= linkThreshold) linked.set(`${i}:${j}`, best.pair);
      else if (cleanFrames[i]![j]! >= minEmbedFrames) addPair(i, j);
      // Otherwise: too little speech to identify; the overlapping windows decide those frames.
    }

    const embeddings: (Float32Array | null)[] = [];
    for (let p = 0; p < pairs.length; p++) {
      const { window, speaker } = pairs[p]!;
      const samples = speakerAudio(audio, clean[window]!, speaker, starts[window]!);
      // The zero-padded last window can claim speech past the end of the audio; too little real
      // audio (or a degenerate result) gives no usable embedding.
      let e: Float32Array | null = null;
      if (samples.length >= 0.1 * SEGMENTATION.sampleRate) {
        e = await models.embed(samples);
        if (!e.length || !e.every(Number.isFinite) || !e.some((v) => v !== 0)) e = null;
      }
      embeddings.push(e);
      onProgress?.(0.3 + 0.65 * ((p + 1) / pairs.length));
    }
    const valid = pairs.map((_, p) => p).filter((p) => embeddings[p] !== null);
    if (valid.length === 0) return [];
    // 3. Global speakers.
    const vectors = valid.map((p) => embeddings[p]!);
    const numClusters = options.numSpeakers ?? null;
    let clusters: number[];
    if (labels.length <= (options.cannotLinkMaxWindows ?? 12)) {
      // With only a few windows (short recordings) there is too little evidence to tell voices
      // apart statistically, so local speakers of one window — whom the segmentation model
      // already told apart — are kept in different clusters. Longer recordings don't need this,
      // and there an occasional split of one voice into two local speakers would add a phantom.
      clusters = clusterEmbeddings(vectors, {
        numClusters,
        threshold: options.shortThreshold ?? 0.5,
        cannotLink: valid.map((p) => pairs[p]!.window),
      });
    } else {
      // Single embeddings of one real voice vary more than some pairs of different voices, so a
      // plain distance threshold splits people up. Ward linkage compares whole groups instead.
      const ward = clusterEmbeddings(vectors, {
        linkage: 'ward',
        numClusters,
        threshold: options.threshold ?? Math.min(2.45, 0.4 * Math.sqrt(vectors.length)),
      });
      // Overlapping windows hear the same speech: count each second once.
      const share = Math.min(1, (anchorEvery * windowShift) / windowSize);
      const seconds = valid.map(
        (p) => cleanFrames[pairs[p]!.window]![pairs[p]!.speaker]! * frameSeconds * share,
      );
      const speech = seconds.reduce((a, b) => a + b, 0);
      clusters = refineClusters(
        vectors,
        ward,
        seconds,
        numClusters
          ? {}
          : {
              minSeconds: options.minSpeakerSeconds ?? Math.min(8, 0.1 * speech),
              mergeSimilarity: options.mergeSimilarity ?? 0.92,
            },
      );
    }
    globalCount = Math.max(...clusters) + 1;
    const clusterOf = new Map<number, number>(valid.map((p, idx) => [p, clusters[idx]!]));
    pairs.forEach((p, idx) => {
      const c = clusterOf.get(idx);
      if (c !== undefined) toGlobal.set(`${p.window}:${p.speaker}`, c);
    });
    for (const [key, pair] of linked) {
      const c = clusterOf.get(pair);
      if (c !== undefined) toGlobal.set(key, c);
    }
  }

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
      const order = Array.from(activity[f]!, (v, g) => [v, g] as const)
        .filter(([v]) => v > 0) // no identified speaker covers this frame: leave it out
        .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      for (let k = 0; k < Math.min(speakers, order.length); k++) row[order[k]![1]] = 1;
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
