// Kaldi-compatible log mel filterbank features, matching kaldi-native-fbank with the options
// sherpa-onnx uses for speaker-embedding models: 25 ms povey window, 10 ms shift, no edge
// snipping, DC removal, 0.97 pre-emphasis, 512-point power spectrum, 80 mel bins between 20 Hz
// and 7600 Hz, log with a FLT_EPSILON floor, no dither.

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

const FLT_EPSILON = 1.1920928955078125e-7;

function mel(freq: number): number {
  return 1127 * Math.log(1 + freq / 700);
}

interface MelBin {
  first: number;
  weights: Float64Array;
}

let cache: {
  window: Float64Array;
  bins: MelBin[];
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint16Array;
} | null = null;

function tables() {
  if (cache) return cache;
  const { frameLength, fftSize, numBins, lowFreq, highFreq, sampleRate } = FBANK;
  const window = new Float64Array(frameLength);
  for (let i = 0; i < frameLength; i++) {
    window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameLength - 1)), 0.85);
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
  cache = { window, bins, cos, sin, rev };
  return cache;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const { cos, sin, rev } = tables();
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

/** Number of frames Kaldi produces for `numSamples` samples without edge snipping. */
export function numFrames(numSamples: number): number {
  return Math.floor((numSamples + FBANK.frameShift / 2) / FBANK.frameShift);
}

/**
 * Log mel filterbank of `samples` (16 kHz, nominally in [-1, 1]) multiplied by `scale`
 * (32768 for models trained on int16-range audio). Returns frames × 80, row-major.
 */
export function computeFbank(samples: Float32Array, scale = 32768): Float32Array {
  const { frameLength, frameShift, fftSize, numBins, preemphasis } = FBANK;
  const { window, bins } = tables();
  const n = samples.length;
  const frames = numFrames(n);
  const out = new Float32Array(frames * numBins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const frame = new Float64Array(frameLength);
  const power = new Float64Array(fftSize / 2 + 1);

  for (let f = 0; f < frames; f++) {
    const start = f * frameShift + frameShift / 2 - frameLength / 2;
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
