import type * as ort from 'onnxruntime-web/webgpu';
import type { OnnxSession } from './ctc';

// The recognizer is tested with a fake session; the runtime and Whisper's module aren't needed.
vi.mock('onnxruntime-web/webgpu', () => ({ Tensor: class {}, InferenceSession: {} }));
vi.mock('./models', () => ({ ModelLoadError: class extends Error {} }));
import { FBANK } from './fbank';
import {
  applyCmvn,
  createSenseVoice,
  piecesToText,
  readSenseVoiceOutput,
  senseVoiceFeatures,
  senseVoiceSettings,
  stackFrames,
} from './sensevoice';

/** Metadata as sherpa-onnx's export writes it (CMVN shortened to a recognisable pattern). */
function metadata(overrides: Record<string, string> = {}): Record<string, string> {
  const dim = 7 * FBANK.numBins;
  return {
    lfr_window_size: '7',
    lfr_window_shift: '6',
    normalize_samples: '0',
    neg_mean: Array.from({ length: dim }, (_, i) => -(i % 80)).join(','),
    inv_stddev: Array.from({ length: dim }, () => '0.5').join(','),
    lang_auto: '0',
    lang_zh: '3',
    lang_en: '4',
    lang_yue: '7',
    lang_ja: '11',
    lang_ko: '12',
    with_itn: '14',
    without_itn: '15',
    ...overrides,
  };
}

describe('stackFrames (LFR)', () => {
  // sherpa-onnx's lfr-test.cc: the first frame is repeated on the left, the last on the right.
  it('stacks 7 frames every 6, padding with the first and last frame', () => {
    const input = Float32Array.from({ length: 13 }, (_, i) => i);
    const { data, frames } = stackFrames(input, 1, 7, 6);
    expect(frames).toBe(3);
    expect(Array.from(data)).toEqual([0, 0, 0, 0, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 12, 12, 12]);
  });

  it.each([
    [1, 1],
    [5, 1],
    [6, 1],
    [7, 2],
    [12, 2],
    [13, 3],
    [20, 4],
  ])('makes ceil(n / 6) output frames from %i input frames', (n, expected) => {
    expect(stackFrames(new Float32Array(n), 1, 7, 6).frames).toBe(expected);
  });

  it('keeps feature dimensions together and handles empty input', () => {
    expect(Array.from(stackFrames(Float32Array.from([0, 1, 2, 3]), 2, 3, 2).data)).toEqual([
      0, 1, 0, 1, 2, 3,
    ]);
    expect(stackFrames(new Float32Array(42), 1, 7, 6).data).toHaveLength(7 * 7);
    expect(stackFrames(new Float32Array(0), 80, 7, 6)).toEqual({ data: new Float32Array(0), frames: 0 });
  });
});

describe('applyCmvn', () => {
  it('adds the negated mean and scales by the inverse deviation, per dimension', () => {
    const data = Float32Array.from([1, 2, 3, 4, 5, 6]);
    applyCmvn(data, Float32Array.from([-1, 0, 1]), Float32Array.from([2, 1, 0.5]));
    expect(Array.from(data)).toEqual([0, 2, 2, 6, 5, 3.5]);
  });
});

describe('senseVoiceSettings', () => {
  it('reads the LFR sizes, CMVN and prompt ids from the metadata', () => {
    const s = senseVoiceSettings(metadata());
    expect(s.lfrWindow).toBe(7);
    expect(s.lfrShift).toBe(6);
    expect(s.negMean).toHaveLength(560);
    expect(s.negMean[81]).toBe(-1);
    expect(s.languageIds).toEqual({ auto: 0, zh: 3, en: 4, yue: 7, ja: 11, ko: 12 });
    expect(s.withItn).toBe(14);
  });

  it('refuses a model whose settings it does not understand', () => {
    expect(() => senseVoiceSettings(metadata({ neg_mean: '1,2,3' }))).toThrow(/Unexpected/);
    expect(() => senseVoiceSettings(metadata({ normalize_samples: '1' }))).toThrow(/Unexpected/);
    expect(() => senseVoiceSettings(metadata({ inv_stddev: 'a,b' }))).toThrow(/inv_stddev/);
  });
});

describe('senseVoiceFeatures', () => {
  it('turns 1 s of audio into 17 frames of 560 normalised features', () => {
    const settings = senseVoiceSettings(metadata());
    const clip = Float32Array.from({ length: 16000 }, (_, i) => 0.1 * Math.sin(i / 7));
    const { data, frames } = senseVoiceFeatures(clip, settings);
    // 98 fbank frames (25 ms window, 10 ms shift, edges snipped) -> ceil(98 / 6) = 17.
    expect(frames).toBe(17);
    expect(data).toHaveLength(17 * 560);
    expect(data.every(Number.isFinite)).toBe(true);
    expect(senseVoiceFeatures(new Float32Array(300), settings).frames).toBe(0);
  });
});

describe('piecesToText', () => {
  it('starts words at "▁" and keeps no space before punctuation', () => {
    expect(piecesToText(['▁The', '▁tri', 'bal', '▁chief', 'tain', '▁called', ' ', ',', '▁ok', '.'])).toBe(
      'The tribal chieftain called, ok.',
    );
  });

  it('writes Chinese and Japanese without spaces, also around numbers', () => {
    expect(piecesToText(['开饭', '时间', '▁', '早上', '9', '点', '。'])).toBe('开饭时间早上9点。');
    expect(piecesToText(['▁1', '▁日に', '授与', '▁18', '▁個の', '、', '▁21', '対', '20', '▁の'])).toBe(
      '1日に授与18個の、21対20の',
    );
    expect(piecesToText(['我们', '用', '▁AI', '▁来', '做'])).toBe('我们用 AI 来做');
  });

  it('keeps the spaces of Korean', () => {
    expect(piecesToText(['▁조금만', '▁생각을', '▁하면서', '▁살면', '.'])).toBe('조금만 생각을 하면서 살면.');
  });
});

describe('readSenseVoiceOutput', () => {
  const tokens = [
    '<unk>',
    '<s>',
    '▁hello',
    '▁world',
    '<|en|>',
    '<|NEUTRAL|>',
    '<|Speech|>',
    '<|withitn|>',
    '<|nospeech|>',
    '<|BGM|>',
    '<|zh|>',
    '你好',
    '。',
  ];

  it('reads the language and event tags and the text after them', () => {
    expect(readSenseVoiceOutput([4, 5, 6, 7, 2, 3], tokens)).toEqual({
      text: 'hello world',
      language: 'en',
      event: 'Speech',
    });
    expect(readSenseVoiceOutput([10, 5, 9, 7, 11], tokens)).toEqual({
      text: '你好',
      language: 'zh',
      event: 'BGM',
    });
  });

  it('drops tags and special tokens inside the text', () => {
    expect(readSenseVoiceOutput([4, 5, 6, 7, 2, 9, 0, 3], tokens).text).toBe('hello world');
  });

  it('copes with missing tags (a tag frame decoded as blank)', () => {
    expect(readSenseVoiceOutput([4, 5, 2], tokens)).toEqual({ text: 'hello', language: 'en', event: null });
  });

  it('gives no text when the model hears no speech, or only punctuation on noise', () => {
    expect(readSenseVoiceOutput([8, 5, 9, 7, 2], tokens)).toEqual({ text: '', language: null, event: 'BGM' });
    expect(readSenseVoiceOutput([10, 5, 9, 7, 12], tokens)).toEqual({
      text: '',
      language: 'zh',
      event: 'BGM',
    });
    expect(readSenseVoiceOutput([], tokens)).toEqual({ text: '', language: null, event: null });
  });
});

describe('createSenseVoice', () => {
  const tokens = ['<unk>', '<|ja|>', '<|NEUTRAL|>', '<|Speech|>', '<|withitn|>', 'こんにちは', '。'];

  /** A session that records its inputs and answers with logits spelling `ids` (one per frame). */
  function fakeSession(ids: number[]) {
    const calls: Record<string, ort.Tensor>[] = [];
    let released = false;
    const session: OnnxSession = {
      async run(feeds) {
        calls.push(feeds);
        const vocab = tokens.length;
        const logits = new Float32Array(ids.length * vocab);
        ids.forEach((id, t) => (logits[t * vocab + id] = 1));
        return { logits: { dims: [1, ids.length, vocab], data: logits } as unknown as ort.Tensor };
      },
      async release() {
        released = true;
      },
    };
    return { session, calls, released: () => released };
  }

  class FakeTensor {
    constructor(
      readonly type: string,
      readonly data: ArrayLike<number>,
      readonly dims: number[],
    ) {}
  }
  const Tensor = FakeTensor as unknown as typeof ort.Tensor;
  const clip = Float32Array.from({ length: 16000 }, (_, i) => 0.1 * Math.sin(i / 5));

  it('feeds the features, the language prompt and ITN, and decodes tags and text', async () => {
    const fake = fakeSession([1, 2, 3, 4, 0, 5, 5, 0, 6]);
    const sv = createSenseVoice(fake.session, metadata(), tokens, Tensor);
    expect(await sv.recognize(clip, 'ja')).toEqual({ text: 'こんにちは。', language: 'ja', event: 'Speech' });
    const feeds = fake.calls[0]!;
    expect(Object.keys(feeds).sort()).toEqual(['language', 'text_norm', 'x', 'x_length']);
    expect(feeds.x!.dims).toEqual([1, 17, 560]);
    expect([feeds.x_length!.type, Array.from(feeds.x_length!.data as Int32Array)]).toEqual(['int32', [17]]);
    expect(Array.from(feeds.language!.data as Int32Array)).toEqual([11]);
    expect(Array.from(feeds.text_norm!.data as Int32Array)).toEqual([14]);
  });

  it('lets the model detect languages it cannot be told, and frees the session', async () => {
    const fake = fakeSession([1, 2, 3, 4, 5]);
    const sv = createSenseVoice(fake.session, metadata(), tokens, Tensor);
    expect(await sv.transcribe(clip, 'fr')).toBe('こんにちは');
    expect(Array.from(fake.calls[0]!.language!.data as Int32Array)).toEqual([0]);
    expect(await sv.transcribe(new Float32Array(100), 'ja')).toBe('');
    expect(fake.calls).toHaveLength(1);
    await sv.dispose();
    expect(fake.released()).toBe(true);
    expect([sv.id, sv.label]).toEqual(['sensevoice', 'SenseVoice']);
  });
});
