// Kaldi-compatible log mel filterbank features, matching kaldi-native-fbank. The defaults are the
// options sherpa-onnx uses for speaker-embedding models: 25 ms povey window, 10 ms shift, no edge
// snipping, DC removal, 0.97 pre-emphasis, 512-point power spectrum, 80 mel bins between 20 Hz
// and 7600 Hz, log with a FLT_EPSILON floor, no dither. SenseVoice uses FunASR's variant.

export const FBANK = {
  sampleRate: 16000,
  frameLength: 400,
  frameShift: 160,
  fftSize: 512,
  numBins: 80,
  lowFreq: 20,
  highFreq: 7600,
  preemphasis: 0.97,
} as const;

/** The Kaldi options that differ between the models. */
export interface FbankOptions {
  window: 'povey' | 'hamming';
  /** Kaldi's snip_edges: only frames that fit in the signal, instead of one per shift (edges reflected). */
  snipEdges: boolean;
  lowFreq: number;
  highFreq: number;
}

/** sherpa-onnx's options for the speaker-embedding model (the default). */
export const SPEAKER_FBANK: FbankOptions = {
  window: 'povey',
  snipEdges: false,
  lowFreq: FBANK.lowFreq,
  highFreq: FBANK.highFreq,
};

/** FunASR's WavFrontend, as sherpa-onnx runs SenseVoice: hamming window, snipped edges, up to 8 kHz. */
export const SENSEVOICE_FBANK: FbankOptions = {
  window: 'hamming',
  snipEdges: true,
  lowFreq: 20,
  highFreq: FBANK.sampleRate / 2,
};

const FLT_EPSILON = 1.1920928955078125e-7;

function mel(freq: number): number {
  return 1127 * Math.log(1 + freq / 700);
}

interface MelBin {
  first: number;
  weights: Float64Array;
}

interface Filters {
  window: Float64Array;
  bins: MelBin[];
}

const filterCache = new Map<string, Filters>();

function filters(options: FbankOptions): Filters {
  const key = `${options.window} ${options.lowFreq} ${options.highFreq}`;
  const cached = filterCache.get(key);
  if (cached) return cached;
  const { frameLength, fftSize, numBins, sampleRate } = FBANK;
  const { lowFreq, highFreq } = options;
  const window = new Float64Array(frameLength);
  for (let i = 0; i < frameLength; i++) {
    const cos = Math.cos((2 * Math.PI * i) / (frameLength - 1));
    window[i] = options.window === 'hamming' ? 0.54 - 0.46 * cos : Math.pow(0.5 - 0.5 * cos, 0.85);
  }

  const numFftBins = fftSize / 2;
  const binWidth = sampleRate / fftSize;
  const melLow = mel(lowFreq);
  const melHigh = mel(highFreq);
  const delta = (melHigh - melLow) / (numBins + 1);
  const bins: MelBin[] = [];
  for (let b = 0; b < numBins; b++) {
    const left = melLow + b * delta;
    const center = left + delta;
    const right = center + delta;
    let first = -1;
    const weights: number[] = [];
    for (let i = 0; i < numFftBins; i++) {
      const m = mel(binWidth * i);
      if (m > left && m < right) {
        if (first < 0) first = i;
        weights.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center));
      }
    }
    bins.push({ first: Math.max(0, first), weights: Float64Array.from(weights) });
  }
  const out = { window, bins };
  filterCache.set(key, out);
  return out;
}

let fftCache: { cos: Float64Array; sin: Float64Array; rev: Uint16Array } | null = null;

function fftTables() {
  if (fftCache) return fftCache;
  const { fftSize } = FBANK;
  const cos = new Float64Array(fftSize / 2);
  const sin = new Float64Array(fftSize / 2);
  for (let i = 0; i < fftSize / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / fftSize);
    sin[i] = Math.sin((-2 * Math.PI * i) / fftSize);
  }
  const bits = Math.log2(fftSize);
  const rev = new Uint16Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  fftCache = { cos, sin, rev };
  return fftCache;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const { cos, sin, rev } = fftTables();
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/** Number of frames Kaldi produces for `numSamples` samples (by default without edge snipping). */
export function numFrames(numSamples: number, snipEdges = false): number {
  const { frameLength, frameShift } = FBANK;
  if (snipEdges)
    return numSamples < frameLength ? 0 : 1 + Math.floor((numSamples - frameLength) / frameShift);
  return Math.floor((numSamples + frameShift / 2) / frameShift);
}

/**
 * Log mel filterbank of `samples` (16 kHz, nominally in [-1, 1]) multiplied by `scale`
 * (32768 for models trained on int16-range audio). Returns frames × 80, row-major.
 */
export function computeFbank(
  samples: Float32Array,
  scale = 32768,
  options: FbankOptions = SPEAKER_FBANK,
): Float32Array {
  const { frameLength, frameShift, fftSize, numBins, preemphasis } = FBANK;
  const { window, bins } = filters(options);
  const n = samples.length;
  const frames = numFrames(n, options.snipEdges);
  const out = new Float32Array(frames * numBins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const frame = new Float64Array(frameLength);
  const power = new Float64Array(fftSize / 2 + 1);
  const offset = options.snipEdges ? 0 : frameShift / 2 - frameLength / 2;

  for (let f = 0; f < frames; f++) {
    const start = f * frameShift + offset;
    let sum = 0;
    for (let s = 0; s < frameLength; s++) {
      let idx = start + s;
      // Kaldi reflects samples outside the signal at both ends.
      while (idx < 0 || idx >= n) idx = idx < 0 ? -idx - 1 : 2 * n - 1 - idx;
      const v = samples[idx]! * scale;
      frame[s] = v;
      sum += v;
    }
    const mean = sum / frameLength;
    for (let s = 0; s < frameLength; s++) frame[s]! -= mean;
    for (let s = frameLength - 1; s > 0; s--) frame[s]! -= preemphasis * frame[s - 1]!;
    frame[0]! -= preemphasis * frame[0]!;

    re.fill(0);
    im.fill(0);
    for (let s = 0; s < frameLength; s++) re[s] = frame[s]! * window[s]!;
    fft(re, im);
    for (let k = 0; k <= fftSize / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;

    for (let b = 0; b < numBins; b++) {
      const { first, weights } = bins[b]!;
      let energy = 0;
      for (let w = 0; w < weights.length; w++) energy += weights[w]! * power[first + w]!;
      out[f * numBins + b] = Math.log(Math.max(energy, FLT_EPSILON));
    }
  }
  return out;
}

/**
 * Subtracts each bin's mean over the frames (cepstral mean normalisation, without variance
 * normalisation), in place. WeSpeaker applies this to every segment before its embedding model:
 * without it the fingerprint follows the recording level and channel more than the voice.
 */
export function subtractMean(feats: Float32Array, numBins: number = FBANK.numBins): Float32Array {
  const frames = feats.length / numBins;
  if (frames === 0) return feats;
  for (let b = 0; b < numBins; b++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += feats[f * numBins + b]!;
    const mean = sum / frames;
    for (let f = 0; f < frames; f++) feats[f * numBins + b]! -= mean;
  }
  return feats;
}
