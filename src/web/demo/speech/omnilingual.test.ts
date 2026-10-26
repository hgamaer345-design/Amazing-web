import type * as ort from 'onnxruntime-web/webgpu';
import { ALLOWED, NOT_ALLOWED, REPLACEMENT, type OnnxSession } from './ctc';
import {
  capitalize,
  charsToText,
  createOmnilingual,
  isMostlyInScript,
  LANGUAGE_SCRIPTS,
  normalizeWaveform,
  scriptMask,
} from './omnilingual';

// The recognizer is tested with a fake session; the runtime and Whisper's module aren't needed.
vi.mock('onnxruntime-web/webgpu', () => ({ Tensor: class {}, InferenceSession: {} }));
vi.mock('./models', () => ({ ModelLoadError: class extends Error {} }));

describe('normalizeWaveform', () => {
  it('scales the clip to zero mean and unit variance, leaving the input alone', () => {
    const clip = Float32Array.from({ length: 4000 }, (_, i) => 0.3 + 0.5 * Math.sin(i / 3));
    const out = normalizeWaveform(clip);
    const mean = out.reduce((s, v) => s + v, 0) / out.length;
    const variance = out.reduce((s, v) => s + (v - mean) ** 2, 0) / out.length;
    expect(Math.abs(mean)).toBeLessThan(1e-4);
    expect(variance).toBeCloseTo(1, 2);
    expect(clip[0]).toBeCloseTo(0.3, 6);
  });

  it('keeps silence finite', () => {
    expect(Array.from(normalizeWaveform(new Float32Array(8)))).toEqual(new Array(8).fill(0));
  });
});

describe('charsToText and capitalize', () => {
  it('drops special tokens and collapses the word boundaries', () => {
    expect(charsToText(['<s>', ' ', 'h', 'a', ' ', ' ', 'b', '<unk>', '</s>', ' '])).toBe('ha b');
    expect(charsToText(['<pad>'])).toBe('');
  });

  it('capitalises the first letter where the script has case', () => {
    expect(capitalize('привет мир')).toBe('Привет мир');
    expect(capitalize('ελλάδα')).toBe('Ελλάδα');
    expect(capitalize('बाबा शाम को')).toBe('बाबा शाम को');
    expect(capitalize('')).toBe('');
  });
});

describe('scripts', () => {
  it('tells which script most letters are in, marks included', () => {
    expect(isMostlyInScript('जब इनसे पूछी गई', 'Arabic')).toBe(false);
    expect(isMostlyInScript('جب ان سے پوچھی گئی', 'Arabic')).toBe(true);
    expect(isMostlyInScript('كَتَبَ', 'Arabic')).toBe(true);
    expect(isMostlyInScript('मुझे नहीं पता AI', 'Devanagari')).toBe(true);
    expect(isMostlyInScript('', 'Devanagari')).toBe(true);
    expect(isMostlyInScript('12 34', 'Hebrew')).toBe(true);
  });

  it("knows every listed language's script", () => {
    for (const script of Object.values(LANGUAGE_SCRIPTS)) expect(isMostlyInScript('a', script)).toBe(false);
    expect(LANGUAGE_SCRIPTS.ur).toBe('Arabic');
    expect(LANGUAGE_SCRIPTS.hi).toBe('Devanagari');
  });

  it('marks letters of the script as replacements and keeps tokens without letters', () => {
    const tokens = ['<s>', ' ', 'a', 'क', 'ि', 'ب', 'َ', '1', '،'];
    expect(Array.from(scriptMask(tokens, 'Arabic'))).toEqual([
      NOT_ALLOWED,
      ALLOWED,
      NOT_ALLOWED,
      NOT_ALLOWED,
      NOT_ALLOWED,
      REPLACEMENT,
      REPLACEMENT,
      ALLOWED,
      ALLOWED,
    ]);
  });
});

describe('createOmnilingual', () => {
  const tokens = ['<s>', '<pad>', '</s>', '<unk>', ' ', 'a', 'b', 'ज', 'ب'];

  class FakeTensor {
    constructor(
      readonly type: string,
      readonly data: Float32Array,
      readonly dims: number[],
    ) {}
  }
  const Tensor = FakeTensor as unknown as typeof ort.Tensor;

  /** Answers every piece with `ids` (one per frame; `second` scores next best) and records the inputs. */
  function fakeSession(ids = [5, 6, 0, 4, 5, 5, 0, 6], second?: number[]) {
    const inputs: FakeTensor[] = [];
    let released = false;
    const session: OnnxSession = {
      async run(feeds) {
        inputs.push(feeds.x as unknown as FakeTensor);
        const logits = new Float32Array(ids.length * tokens.length);
        ids.forEach((id, t) => (logits[t * tokens.length + id] = 3));
        second?.forEach((id, t) => (logits[t * tokens.length + id] = 2));
        return { logits: { dims: [1, ids.length, tokens.length], data: logits } as unknown as ort.Tensor };
      },
      async release() {
        released = true;
      },
    };
    return { session, inputs, released: () => released };
  }

  const noise = (seconds: number) => {
    let seed = 3;
    return Float32Array.from({ length: seconds * 16000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return 0.2 * (seed / 2147483648 - 0.5);
    });
  };

  it('decodes a whole clip from the normalised waveform', async () => {
    const fake = fakeSession();
    const omni = createOmnilingual(fake.session, tokens, Tensor);
    expect(await omni.transcribe(noise(25), 'sw')).toBe('Ab ab');
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]!.dims).toEqual([1, 25 * 16000]);
    expect([omni.id, omni.label]).toEqual(['omnilingual', 'Omnilingual ASR']);
  });

  it('hears a long clip in pieces when told to, joined into one text', async () => {
    const fake = fakeSession();
    const omni = createOmnilingual(fake.session, tokens, Tensor, 10);
    expect(await omni.transcribe(noise(25), 'sw')).toBe('Ab ab ab ab ab ab');
    expect(fake.inputs.map((t) => t.dims[1]!).every((n) => n <= 10 * 16000)).toBe(true);
    expect(fake.inputs.reduce((n, t) => n + t.dims[1]!, 0)).toBe(25 * 16000);
  });

  it("writes in the language's script when the model chose another one", async () => {
    // Devanagari "ज" first everywhere, Arabic "ب" second; blanks between.
    const fake = fakeSession([7, 0, 4, 7, 0, 7], [8, 4, 0, 8, 8, 8]);
    const omni = createOmnilingual(fake.session, tokens, Tensor);
    expect(await omni.transcribe(noise(1), 'ur')).toBe('ب بب');
    expect(await omni.transcribe(noise(1), 'hi')).toBe('ज जज');
    expect(await omni.transcribe(noise(1), 'sw')).toBe('ज जज');
    expect(fake.inputs).toHaveLength(3);
  });

  it("keeps the model's own text when it is in an unrelated script (the language label is wrong)", async () => {
    // Latin letters for speech labelled Arabic: not Hindi/Urdu's script swap, so nothing is forced.
    const fake = fakeSession([5, 0, 4, 6, 0, 5], [8, 4, 0, 8, 8, 8]);
    const omni = createOmnilingual(fake.session, tokens, Tensor);
    expect(await omni.transcribe(noise(1), 'ar')).toBe('A ba');
  });

  it('gives no text for a lone letter (what noise produces)', async () => {
    const fake = fakeSession([0, 0, 5, 0, 4, 0]);
    expect(await createOmnilingual(fake.session, tokens, Tensor).transcribe(noise(1), 'sw')).toBe('');
  });

  it('skips clips too short for the model and frees the session', async () => {
    const fake = fakeSession();
    const omni = createOmnilingual(fake.session, tokens, Tensor);
    expect(await omni.transcribe(new Float32Array(399), 'sw')).toBe('');
    expect(fake.inputs).toHaveLength(0);
    await omni.dispose();
    expect(fake.released()).toBe(true);
  });
});
