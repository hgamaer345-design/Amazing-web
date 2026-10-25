import { planTurns, speechSample } from './turns';

const seg = (start: number, end: number, speaker: number) => ({ start, end, speaker });

describe('planTurns', () => {
  it('pads turns, joins short same-speaker pauses and keeps speaker changes', () => {
    const turns = planTurns([seg(1, 2, 0), seg(2.5, 3, 0), seg(3.2, 4, 1), seg(8, 9, 1)], 16000 * 10, {
      padding: 0.1,
      joinGap: 1,
    });
    expect(turns).toEqual([
      { speaker: 0, start: 14400, end: 49600 },
      { speaker: 1, start: 49600, end: 65600 },
      { speaker: 1, start: 126400, end: 145600 },
    ]);
  });

  it('keeps overlapping speech from different speakers as separate clips and clamps to the audio', () => {
    const turns = planTurns([seg(0, 5, 0), seg(4, 6, 1)], 16000 * 5.5, { padding: 0.2 });
    expect(turns).toEqual([
      { speaker: 0, start: 0, end: 83200 },
      { speaker: 1, start: 60800, end: 88000 },
    ]);
  });

  it('returns nothing for no segments', () => {
    expect(planTurns([], 1000)).toEqual([]);
  });
});

describe('speechSample', () => {
  it('concatenates speech up to the limit', () => {
    const audio = Float32Array.from({ length: 100 }, (_, i) => i);
    const out = speechSample(
      audio,
      [
        { speaker: 0, start: 10, end: 20 },
        { speaker: 1, start: 50, end: 60 },
      ],
      15,
      1,
    );
    expect(Array.from(out)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 50, 51, 52, 53, 54]);
  });
});
