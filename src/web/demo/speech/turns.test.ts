import { planTurns, speechSample, splitLongTurns, spreadSample } from './turns';

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

describe('spreadSample', () => {
  const audio = Float32Array.from({ length: 1000 }, (_, i) => i);
  const turns = [
    { speaker: 0, start: 0, end: 300 },
    { speaker: 0, start: 500, end: 800 },
  ];

  it('takes equal parts from the start, middle and end of the speech', () => {
    // 600 samples of speech, 30 wanted: 10 at speech offsets 0, 295 and 590.
    const out = spreadSample(audio, turns, 30, 3, 1);
    expect(Array.from(out.subarray(0, 10))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(out.subarray(10, 20))).toEqual([295, 296, 297, 298, 299, 500, 501, 502, 503, 504]);
    expect(Array.from(out.subarray(20, 30))).toEqual([790, 791, 792, 793, 794, 795, 796, 797, 798, 799]);
  });

  it('is all of the speech when there is little', () => {
    expect(spreadSample(audio, turns, 1000, 3, 1)).toEqual(speechSample(audio, turns, 1000, 1));
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

describe('planTurns with overlapping speech', () => {
  it("drops a brief segment buried in another speaker's speech and joins around it", () => {
    const turns = planTurns(
      [seg(1, 9, 0), seg(4.2, 4.9, 1), seg(9.4, 12, 0), seg(12.5, 13.2, 1)],
      16000 * 20,
      {
        padding: 0,
      },
    );
    // 4.2–4.9 lies inside speaker 0's turn; 12.5–13.2 is short but on its own, so it stays.
    expect(turns.map((t) => [t.speaker, t.start / 16000, t.end / 16000])).toEqual([
      [0, 1, 12],
      [1, 12.5, 13.2],
    ]);
  });
});

describe('splitLongTurns', () => {
  it('cuts long turns at the quietest point before each limit and leaves short ones alone', () => {
    const sr = 100; // small rate keeps the test readable
    const audio = new Float32Array(100 * sr).fill(0.5);
    audio.fill(0, 25 * sr, 25 * sr + 20); // a pause at 25 s
    audio.fill(0, 51 * sr, 51 * sr + 20); // and at 51 s
    const turns = splitLongTurns(
      audio,
      [
        { speaker: 0, start: 0, end: 70 * sr },
        { speaker: 1, start: 70 * sr, end: 80 * sr },
      ],
      { sampleRate: sr, maxSeconds: 28, searchSeconds: 4 },
    );
    expect(turns.map((t) => [t.speaker, t.start / sr, t.end / sr])).toEqual([
      [0, 0, 25.02],
      [0, 25.02, 51.02],
      [0, 51.02, 70],
      [1, 70, 80],
    ]);
  });
});
