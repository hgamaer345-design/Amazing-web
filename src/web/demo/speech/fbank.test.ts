// Reference values come from kaldi-native-fbank with sherpa-onnx's speaker-embedding options
// (see the generator in docs/ARCHITECTURE.md "In-browser transcription").
import fixture from './__fixtures__/fbank.json';
import { computeFbank, FBANK, numFrames } from './fbank';

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
