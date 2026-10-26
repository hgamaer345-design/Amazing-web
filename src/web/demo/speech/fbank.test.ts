// Reference values come from kaldi-native-fbank with sherpa-onnx's speaker-embedding options
// (see the generator in docs/ARCHITECTURE.md "In-browser transcription").
import fixture from './__fixtures__/fbank.json';
import { computeFbank, FBANK, numFrames, subtractMean } from './fbank';

describe('computeFbank', () => {
  it('matches kaldi-native-fbank to within float rounding', () => {
    const samples = Float32Array.from(fixture.samples);
    const out = computeFbank(samples);
    expect(out.length / FBANK.numBins).toBe(fixture.frames.length);
    let maxDiff = 0;
    fixture.frames.forEach((frame, f) => {
      frame.forEach((expected, b) => {
        maxDiff = Math.max(maxDiff, Math.abs(out[f * FBANK.numBins + b]! - expected));
      });
    });
    expect(maxDiff).toBeLessThan(2e-3);
  });

  it('produces Kaldi frame counts without edge snipping', () => {
    expect(numFrames(48000)).toBe(300);
    expect(numFrames(79)).toBe(0);
    expect(numFrames(80)).toBe(1);
    expect(numFrames(160)).toBe(1);
    expect(numFrames(240)).toBe(2);
  });

  it('handles silence (log floor) and very short input', () => {
    const silent = computeFbank(new Float32Array(1600));
    expect(silent.every((v) => Number.isFinite(v))).toBe(true);
    expect(computeFbank(new Float32Array(10)).length).toBe(0);
  });
});

describe('subtractMean', () => {
  it('centres every bin over the frames, so a louder copy gives the same features', () => {
    // Broadband (pseudo-random) so that no bin sits at the log floor.
    let seed = 1;
    const tone = Float32Array.from({ length: 8000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return 0.1 * (seed / 2147483648 - 0.5);
    });
    const quiet = subtractMean(computeFbank(tone));
    const loud = subtractMean(computeFbank(tone.map((v) => v * 10)));
    const frames = quiet.length / FBANK.numBins;
    for (let b = 0; b < FBANK.numBins; b++) {
      let sum = 0;
      for (let f = 0; f < frames; f++) sum += quiet[f * FBANK.numBins + b]!;
      expect(Math.abs(sum / frames)).toBeLessThan(1e-4);
    }
    // A gain is a constant offset in log-mel energy, which the mean removes.
    for (let i = 0; i < quiet.length; i++) expect(loud[i]).toBeCloseTo(quiet[i]!, 3);
  });

  it('leaves empty input alone', () => {
    expect(subtractMean(new Float32Array(0))).toEqual(new Float32Array(0));
  });
});
