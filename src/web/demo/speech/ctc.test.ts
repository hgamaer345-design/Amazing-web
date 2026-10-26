import {
  ALLOWED,
  ctcGreedy,
  fetchCtcModel,
  NOT_ALLOWED,
  onnxMetadata,
  parseTokens,
  REPLACEMENT,
} from './ctc';
import { encodeModel, fakeServer } from './__fixtures__/fakeModel';

describe('parseTokens', () => {
  it('maps ids to symbols, a line holding only an id being the space symbol', () => {
    const tokens = parseTokens('<s> 0\n<pad> 1\n  4\n▁the 3\nक 2\r\n');
    expect(tokens).toEqual(['<s>', '<pad>', 'क', '▁the', ' ']);
  });

  it('rejects a line without an id', () => {
    expect(() => parseTokens('<s> 0\nabc\n')).toThrow(/Bad token line/);
  });
});

describe('ctcGreedy', () => {
  // Frames × 4 classes, class 0 the blank.
  const frames = (...best: number[]) => {
    const logits = new Float32Array(best.length * 4);
    best.forEach((b, t) => (logits[t * 4 + b] = 5));
    return logits;
  };

  it('merges repeats and drops blanks; a blank between two equal classes keeps both', () => {
    expect(ctcGreedy(frames(1, 1, 0, 2, 2, 2, 0, 0, 2, 3), 10, 4)).toEqual([1, 2, 2, 3]);
    expect(ctcGreedy(frames(0, 0, 0), 3, 4)).toEqual([]);
    expect(ctcGreedy(new Float32Array(0), 0, 4)).toEqual([]);
  });

  it('replaces classes that are not allowed by the best replacement, never by the blank', () => {
    // Class 3 wins every frame, 2 comes second on frame 0, the blank second on frame 1, 1 third.
    const logits = new Float32Array([0, 1, 2, 3, 2.5, 1, 0, 3, 0, 0, 0, 0, 9, 0, 0, 0]);
    const allowed = Uint8Array.from([ALLOWED, REPLACEMENT, ALLOWED, NOT_ALLOWED]);
    expect(ctcGreedy(logits, 4, 4)).toEqual([3]);
    expect(ctcGreedy(logits, 4, 4, 0, allowed)).toEqual([1]);
    expect(ctcGreedy(logits, 4, 4, 0, Uint8Array.from([ALLOWED, ALLOWED, ALLOWED, ALLOWED]))).toEqual([3]);
  });

  it('honours another blank id and takes the first of equal scores', () => {
    expect(ctcGreedy(frames(3, 1, 3), 3, 4, 3)).toEqual([1]);
    expect(ctcGreedy(new Float32Array([0, 1, 1, 0]), 1, 4, 3)).toEqual([1]);
  });
});

describe('onnxMetadata', () => {
  it("reads the model's key-value metadata without touching the graph", () => {
    const model = encodeModel({
      metadata: { lfr_window_size: '7', comment: 'iic/SenseVoiceSmall', 空: 'ü' },
    });
    expect(onnxMetadata(model)).toEqual({ lfr_window_size: '7', comment: 'iic/SenseVoiceSmall', 空: 'ü' });
    expect(onnxMetadata(encodeModel({}))).toEqual({});
  });

  it('rejects truncated files', () => {
    const model = encodeModel({ metadata: { a: 'b' } });
    expect(() => onnxMetadata(model.subarray(0, model.length - 3))).toThrow(/truncated/);
  });
});

describe('fetchCtcModel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the graph, the weight parts as external data and the token table', async () => {
    const server = fakeServer('models/demo-model/', {
      'model.aaaa.onnx': new Uint8Array([1, 2, 3]),
      'model.bbbb.data': new Uint8Array([4, 5]),
      'model.cccc.data': new Uint8Array([6]),
      'tokens.dddd.txt': new TextEncoder().encode('<blk> 0\n▁a 1\n'),
    });
    vi.stubGlobal('fetch', server.fetch);
    const progress: [number, number][] = [];
    const files = await fetchCtcModel('demo-model', (loaded, total) => progress.push([loaded, total]));
    expect(Array.from(files.model)).toEqual([1, 2, 3]);
    expect(files.externalData.map((f) => [f.path, Array.from(f.data)])).toEqual([
      ['model.bbbb.data', [4, 5]],
      ['model.cccc.data', [6]],
    ]);
    expect(files.tokens).toEqual(['<blk>', '▁a']);
    const total = 3 + 2 + 1 + 15;
    expect(progress.at(-1)).toEqual([total, total]);
    expect(progress.every(([l, t], i) => t === total && l >= (progress[i - 1]?.[0] ?? 0))).toBe(true);
  });
});
