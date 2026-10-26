// fbank-sensevoice.json: kaldi-native-fbank with sherpa-onnx's SenseVoice options (hamming window,
// snip_edges, high_freq 0 = Nyquist, no dither) on the samples of fbank.json scaled by 32768,
// rounded to 4 decimals.
import fixture from './__fixtures__/fbank.json';
import svFixture from './__fixtures__/fbank-sensevoice.json';
import { computeFbank, FBANK, numFrames, SENSEVOICE_FBANK } from './fbank';

describe('computeFbank with SenseVoice options', () => {
  it('matches kaldi-native-fbank', () => {
    const out = computeFbank(Float32Array.from(fixture.samples), 32768, SENSEVOICE_FBANK);
    expect(out.length / FBANK.numBins).toBe(svFixture.frames.length);
    let maxDiff = 0;
    svFixture.frames.forEach((frame, f) => {
      frame.forEach((expected, b) => {
        maxDiff = Math.max(maxDiff, Math.abs(out[f * FBANK.numBins + b]! - expected));
      });
    });
    expect(maxDiff).toBeLessThan(2e-3);
  });

  it('produces Kaldi frame counts with edge snipping', () => {
    expect(numFrames(399, true)).toBe(0);
    expect(numFrames(400, true)).toBe(1);
    expect(numFrames(559, true)).toBe(1);
    expect(numFrames(560, true)).toBe(2);
    expect(numFrames(48000, true)).toBe(298);
    expect(computeFbank(new Float32Array(399), 32768, SENSEVOICE_FBANK).length).toBe(0);
  });
});
