import { diarize, SEGMENTATION, type DiarizationModels } from './diarize';

const SR = 16000;

/**
 * Fake audio where each speaker's speech is a constant level (speaker k -> 0.1 * (k + 1)) and
 * silence is 0. The fake segmenter numbers the speakers of each window by first appearance (so
 * local labels differ between windows, like the real model) and the fake embedder returns a
 * one-hot vector for the level it hears.
 */
function scene(turns: [speaker: number, start: number, end: number][], seconds: number) {
  const audio = new Float32Array(seconds * SR);
  for (const [k, start, end] of turns) audio.fill(0.1 * (k + 1), start * SR, end * SR);
  return audio;
}

function fakeModels(): DiarizationModels & { embedCalls: number } {
  const frames = 589;
  const models = {
    embedCalls: 0,
    async segment(windows: Float32Array[]) {
      return windows.map((w) => {
        const logits = new Float32Array(frames * SEGMENTATION.numClasses).fill(-10);
        const local = new Map<number, number>();
        for (let f = 0; f < frames; f++) {
          const level = Math.round(w[Math.floor(((f + 0.5) / frames) * w.length)]! * 10);
          let cls = 0;
          if (level > 0) {
            if (!local.has(level) && local.size < 3) local.set(level, local.size);
            const j = local.get(level);
            cls = j === undefined ? 0 : j + 1; // powerset classes 1..3 = one local speaker
          }
          logits[f * SEGMENTATION.numClasses + cls] = 10;
        }
        return logits;
      });
    },
    async embed(samples: Float32Array) {
      models.embedCalls++;
      const counts = new Float32Array(8);
      for (const v of samples) counts[Math.round(v * 10)]! += 1;
      counts[0] = 0;
      const best = counts.indexOf(Math.max(...counts));
      const e = new Float32Array(8);
      e[best] = 1;
      return e;
    },
  };
  return models;
}

/** Like fakeModels, but levels are bit masks (0.1, 0.2, 0.4; sums are overlapping speech). */
function overlapModels(heard: Set<number>): DiarizationModels {
  const frames = 589;
  const powerset = ['', '0', '1', '2', '01', '02', '12'];
  return {
    async segment(windows) {
      return windows.map((w) => {
        const logits = new Float32Array(frames * SEGMENTATION.numClasses).fill(-10);
        const local = new Map<number, number>();
        for (let f = 0; f < frames; f++) {
          const mask = Math.round(w[Math.floor(((f + 0.5) / frames) * w.length)]! * 10);
          const active: number[] = [];
          for (const bit of [1, 2, 4]) {
            if (!(mask & bit)) continue;
            if (!local.has(bit) && local.size < 3) local.set(bit, local.size);
            if (local.has(bit)) active.push(local.get(bit)!);
          }
          const cls = Math.max(0, powerset.indexOf(active.sort().join('')));
          logits[f * SEGMENTATION.numClasses + cls] = 10;
        }
        return logits;
      });
    },
    async embed(samples) {
      const e = new Float32Array(8);
      for (const v of samples) {
        const mask = Math.round(v * 10);
        heard.add(mask);
        for (const bit of [1, 2, 4]) if (mask & bit) e[bit] = (e[bit] ?? 0) + 1;
      }
      return e;
    },
  };
}

const TURNS: [number, number, number][] = [
  [0, 0.5, 6],
  [1, 6.8, 11],
  [0, 11.8, 15],
  [2, 15.6, 24],
  [1, 24.7, 31],
  [0, 31.6, 38],
  [2, 38.8, 45],
  [1, 45.5, 58],
];

function summary(segments: { start: number; end: number; speaker: number }[]) {
  return segments.map((s) => `${s.speaker}@${s.start.toFixed(1)}-${s.end.toFixed(1)}`);
}

describe('diarize', () => {
  it('finds who spoke when, numbering speakers by first appearance', async () => {
    const segments = await diarize(scene(TURNS, 60), fakeModels(), { windowShift: SR });
    expect(segments.map((s) => s.speaker)).toEqual(TURNS.map((t) => t[0]));
    segments.forEach((s, i) => {
      expect(Math.abs(s.start - TURNS[i]![1])).toBeLessThan(0.1);
      expect(Math.abs(s.end - TURNS[i]![2])).toBeLessThan(0.1);
    });
  });

  it('embeds only anchor windows with embedStride and gives the same result', async () => {
    const audio = scene(TURNS, 60);
    const every = fakeModels();
    const anchored = fakeModels();
    const full = await diarize(audio, every, { windowShift: SR });
    const fast = await diarize(audio, anchored, { windowShift: SR, embedStride: 5 * SR });
    expect(summary(fast)).toEqual(summary(full));
    expect(anchored.embedCalls).toBeLessThan(every.embedCalls / 3);
  });

  it('respects a known number of speakers', async () => {
    const segments = await diarize(scene(TURNS, 60), fakeModels(), {
      windowShift: SR,
      embedStride: 5 * SR,
      numSpeakers: 2,
    });
    expect(new Set(segments.map((s) => s.speaker)).size).toBe(2);
  });

  it('builds embeddings only from frames where a single speaker talks', async () => {
    // Levels are bit masks here (TURNS' speakers 0, 1, 2 -> 0.1, 0.2, 0.4); 0.3 = speakers 0 and 1.
    const audio = new Float32Array(60 * SR);
    for (const [k, start, end] of TURNS) audio.fill(0.1 * 2 ** k, start * SR, end * SR);
    audio.fill(0.3, 5 * SR, 6 * SR);
    const heard = new Set<number>();
    const models = overlapModels(heard);
    await diarize(audio, models, { windowShift: SR, embedStride: 5 * SR });
    expect(heard.has(3)).toBe(false);
    // Each pure voice was heard (0 = the silence at frame edges).
    expect([...heard].filter((m) => m > 0).sort()).toEqual([1, 2, 4]);
  });

  it("keeps the segmentation model's own speakers for a single window", async () => {
    // Identical "voices" would be merged by clustering; within one window the model tells them apart.
    const models = { ...fakeModels(), embed: async () => Float32Array.of(1, 0, 0) };
    const segments = await diarize(
      scene(
        [
          [0, 0.5, 3],
          [1, 3.5, 7],
        ],
        8,
      ),
      models,
    );
    expect(segments.map((s) => s.speaker)).toEqual([0, 1]);
    const told = await diarize(
      scene(
        [
          [0, 0.5, 3],
          [1, 3.5, 7],
        ],
        8,
      ),
      models,
      { numSpeakers: 1 },
    );
    expect(new Set(told.map((s) => s.speaker)).size).toBe(1);
  });

  it('keeps the speakers of one window apart in a short recording, even with similar voices', async () => {
    // 12 s = two windows at a 2 s hop; every "voice" embeds identically, so only the constraint
    // that a window's local speakers are different people keeps them apart.
    const models = { ...fakeModels(), embed: async () => Float32Array.of(1, 0, 0) };
    const turns: [number, number, number][] = [
      [0, 0.5, 3],
      [1, 3.5, 6],
      [0, 6.5, 9],
      [1, 9.5, 11.5],
    ];
    const short = await diarize(scene(turns, 12), models, { windowShift: 2 * SR, embedStride: 5 * SR });
    expect(short.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
    // Without the constraint (as for long recordings) the identical voices merge.
    const merged = await diarize(scene(turns, 12), models, {
      windowShift: 2 * SR,
      embedStride: 5 * SR,
      cannotLinkMaxWindows: 0,
    });
    expect(new Set(merged.map((s) => s.speaker)).size).toBe(1);
  });

  it('handles silence and audio shorter than one window', async () => {
    expect(await diarize(new Float32Array(3 * SR), fakeModels())).toEqual([]);
    const short = await diarize(scene([[0, 0.5, 3]], 4), fakeModels(), { embedStride: 5 * SR });
    expect(short).toHaveLength(1);
    expect(short[0]!.speaker).toBe(0);
  });
});
