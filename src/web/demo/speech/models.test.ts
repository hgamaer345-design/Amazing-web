// Whisper's checked transcription (decodeScored, transcribeClipChecked) on a scripted fake Whisper:
// the loop guard, the special tokens kept out of the text, the token limit per script, the second
// decode with the whole budget, and the split of a clip whose text was cut off.
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

vi.mock('@huggingface/transformers', () => ({ env: {}, pipeline: vi.fn(), Tensor: class {} }));
vi.mock('onnxruntime-web/webgpu', () => ({ env: { wasm: {} }, InferenceSession: {}, Tensor: class {} }));

const { transcribeClipChecked } = await import('./models');

const VOCAB = 51865;
const END = 50257;
const NO_TIMESTAMPS = 50363;
const TIMESTAMP_BEGIN = 50364; // <|0.00|>
const PROMPT = [50258, 50259, 50359]; // <|startoftranscript|><|en|><|transcribe|>
const [FIRST_LANGUAGE, LAST_LANGUAGE] = [50259, 50357]; // <|en|> … <|su|>
const CHINESE = 50260; // <|zh|>
const at = (seconds: number) => TIMESTAMP_BEGIN + Math.round(seconds / 0.02);

/**
 * What the fake Whisper wants to write next after `text` (most wanted first) for `clip`, in a
 * decode with or without timestamps.
 */
type Script = (text: readonly number[], clip: Float32Array, timestamps?: boolean) => number[];

interface Pass {
  timestamps: boolean;
  maxNewTokens: number;
  /** Every token Whisper chose, but the last <|endoftext|>. */
  ids: number[];
  text: string;
}

type Processor = (ids: bigint[][], logits: { data: Float32Array; dims: number[] }) => unknown;

/**
 * A Whisper pipeline that writes greedily from `script`'s preferences (any tokens it doesn't name
 * score lower), with the processors decodeScored gives it applied at every step, in the list its
 * model builds as Transformers.js 4.3.1 does (`_get_logits_processor`). `words` are the tokens'
 * texts, by id. Its text is read from the tokens as Transformers.js reads it (see `readText`), with
 * its tokenizer, which like the real one throws on decoding no tokens.
 */
function fakeWhisper(words: string[], script: Script) {
  const passes: Pass[] = [];
  const decode = (ids: number[]) =>
    ids
      .filter((id) => id < END)
      .map((id) => words[id])
      .join('');
  const tokenizer = {
    decode(ids: number[]) {
      if (ids.length === 0) throw Error('token_ids must be a non-empty array of integers.');
      return decode(ids);
    },
  };
  // WhisperTokenizer._decode_asr: without timestamps, a language token other than the last one
  // closes the text so far, and so does a timestamp after another, in any decode; the text is
  // decoded then, even when there is none.
  const readText = (ids: number[], timestamps: boolean) => {
    const texts: string[] = [];
    let language = PROMPT[1];
    let opened: number | null = null;
    let current: number[] = [];
    const close = () => {
      texts.push(tokenizer.decode(current));
      current = [];
    };
    for (const id of ids.slice(PROMPT.length)) {
      if (id >= FIRST_LANGUAGE && id <= LAST_LANGUAGE) {
        if (!timestamps && id !== language) close();
        language = id;
      } else if (id >= TIMESTAMP_BEGIN) {
        if (opened === null) opened = id;
        else if (id !== opened) {
          close();
          opened = null;
        }
      } else if (id < END) current.push(id);
    }
    if (current.length) texts.push(tokenizer.decode(current));
    return texts.join('');
  };
  const model = {
    generation_config: { eos_token_id: END, no_timestamps_token_id: NO_TIMESTAMPS },
    async forward(_inputs: unknown) {
      const data = new Float32Array(VOCAB);
      data[NO_TIMESTAMPS - 1] = -10; // <|nocaptions|>: somebody is speaking
      return { logits: { dims: [1, 1, VOCAB], data } };
    },
    // Transformers.js's own rules (none here), then the caller's, with Whisper's timestamp rules.
    _get_logits_processor: (_config: unknown, _length: number, processors: Processor[]) => [...processors],
  };
  type Options = { return_timestamps: boolean; max_new_tokens: number; logits_processor: Processor[] };
  const asr = async (clip: Float32Array, opts: Options) => {
    await model.forward({});
    const ids = [...PROMPT, ...(opts.return_timestamps ? [] : [NO_TIMESTAMPS])];
    const processors = model._get_logits_processor({}, ids.length, opts.logits_processor);
    const text: number[] = [];
    for (let step = 0; step < opts.max_new_tokens; step++) {
      const data = new Float32Array(VOCAB).fill(-20);
      script(text, clip, opts.return_timestamps).forEach((id, rank) => (data[id] = 10 - rank));
      for (const process of processors) process([ids.map(BigInt)], { data, dims: [1, VOCAB] });
      let next = 0;
      for (let i = 1; i < VOCAB; i++) if (data[i]! > data[next]!) next = i;
      ids.push(next);
      if (next === END) break;
      text.push(next);
    }
    passes.push({
      timestamps: opts.return_timestamps,
      maxNewTokens: opts.max_new_tokens,
      ids: text,
      text: decode(text),
    });
    return { text: readText(ids, opts.return_timestamps) };
  };
  Object.assign(asr, { model, tokenizer });
  return { asr: asr as unknown as AutomaticSpeechRecognitionPipeline, passes };
}

const clipOf = (seconds: number, value = 0.1) => new Float32Array(seconds * 16000).fill(value);

/** Ids of the words of a sentence, in a shared vocabulary. */
function vocabulary() {
  const words: string[] = [];
  const id = (word: string) => {
    if (!words.includes(word)) words.push(word);
    return words.indexOf(word);
  };
  return { words, ids: (...ws: string[]) => ws.map(id) };
}

/** After `text`, the next token of `sentence` (then the end), or of the first sentence it continues. */
function follows(...sentences: number[][]): Script {
  return (text) => {
    for (const s of sentences) {
      for (let at = Math.min(text.length, s.length); at >= 1; at--) {
        if (s.slice(0, at).every((id, k) => id === text[text.length - at + k])) {
          return s.length > at ? [s[at]!, END] : [END];
        }
      }
    }
    return [sentences[0]![0]!];
  };
}

describe('transcribeClipChecked', () => {
  it('steers Whisper out of a chant so the speech after it is transcribed', async () => {
    const { words, ids } = vocabulary();
    const [go, bang, come, on, run] = ids(' Go', '!', ' Come', ' on,', ' run.');
    // Whisper would chant "Go!" for ever; when " Go" is banned it goes on with " Come".
    const script: Script = (text) => {
      const last = text.at(-1);
      if (last === undefined || last === bang) return [go!, come!];
      if (last === go) return [bang!];
      if (last === come) return [on!];
      if (last === on) return [run!];
      return [END];
    };
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clipOf(5), 'en');
    expect(out.text).toBe('Go! Come on, run.');
    expect(passes[0]!.text).toBe(`${' Go!'.repeat(9)} Come on, run.`);
  });

  it('ends the text when Whisper keeps looping after the ban', async () => {
    const { words, ids } = vocabulary();
    const [go, bang, goLower] = ids(' Go', '!', ' go');
    // Banned " Go", Whisper writes " go" and then chants on.
    const script: Script = (text) =>
      text.at(-1) === go || text.at(-1) === goLower ? [bang!] : [go!, goLower!];
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clipOf(5), 'en');
    // Ended after 36 of the 100 tokens allowed, in both passes.
    expect(passes.map((p) => p.text)).toEqual(
      [0, 1].map(() => `${' Go!'.repeat(9)} go!${' Go!'.repeat(8)} Go`),
    );
    expect(out.text).toBe('Go!');
  });

  it('writes the text instead of the language and other special tokens Whisper wants in it', async () => {
    const { words, ids } = vocabulary();
    const sentence = ids(' Turn', ' it', ' up.');
    // Whisper Base wrote <|zh|> first on a quiet Spanish clip, Small <|notimestamps|> in Italian.
    const script: Script = (text, clip) => {
      const next = follows(sentence)(text, clip);
      if (text.length === 0) return [CHINESE, ...next];
      return text.length === 2 ? [NO_TIMESTAMPS, ...next] : next;
    };
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clipOf(5), 'en');
    expect(passes.map((p) => p.ids)).toEqual([sentence]);
    expect(out).toMatchObject({ text: 'Turn it up.', doubtful: false });
  });

  it('keeps the timestamps of a decode with timestamps', async () => {
    const { words, ids } = vocabulary();
    const [go, bang, goLower] = ids(' Go', '!', ' go');
    const sentence = ids(' Turn', ' it', ' up.');
    // Without timestamps Whisper chants; with them it writes the sentence, and wants <|zh|> once.
    const script: Script = (text, clip, timestamps) => {
      if (!timestamps) return text.at(-1) === go || text.at(-1) === goLower ? [bang!] : [go!, goLower!];
      if (text.length === 0) return [at(0)];
      if (text.length === 1) return [CHINESE, sentence[0]!];
      if (text.at(-1) === sentence[2]) return [at(1.5)];
      return text.at(-1) === at(1.5) ? [END] : follows(sentence)(text, clip);
    };
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clipOf(5), 'en');
    expect(passes.map((p) => p.timestamps)).toEqual([false, true]);
    expect(passes[1]!.ids).toEqual([at(0), ...sentence, at(1.5)]);
    expect(out.text).toBe('Turn it up.');
  });

  it("scores a decode as before when a language token is only Whisper's second choice", async () => {
    const { words, ids } = vocabulary();
    const sentence = ids(' Turn', ' it', ' up.');
    const [spare] = ids(' spare');
    const confidence = async (second: number) => {
      const script: Script = (text, clip) => {
        const [next, ...rest] = follows(sentence)(text, clip);
        return [next!, second, ...rest];
      };
      const { asr, passes } = fakeWhisper(words, script);
      const out = await transcribeClipChecked(asr, clipOf(5), 'en');
      expect(passes.map((p) => p.ids)).toEqual([sentence]);
      return out.confidence;
    };
    // The language token's share counts against the tokens Whisper chose, as a text token's does.
    expect(await confidence(CHINESE)).toBeCloseTo(await confidence(spare!), 12);
  });

  it('scores the last token of a text the token limit cut off as the one Whisper wrote', async () => {
    const { words, ids } = vocabulary();
    const sentence = ids(...Array.from({ length: 60 }, (_, i) => `t${i} `));
    // Whisper wants <|zh|> at the 52nd token, the last the limit lets it write on 2 s of audio.
    const script: Script = (text, clip) => [
      ...(text.length === 51 ? [CHINESE] : []),
      ...follows(sentence)(text, clip),
    ];
    const confidence = async (seconds: number) => {
      const { asr, passes } = fakeWhisper(words, script);
      const out = await transcribeClipChecked(asr, clipOf(seconds), 'en');
      expect(passes.at(-1)!.ids).toEqual(sentence);
      return out.confidence;
    };
    // Scored with the word it wrote there, the cut-off decode is no surer than the whole text,
    // which a 4 s clip gets in one decode.
    expect(await confidence(2)).toBeCloseTo(await confidence(4), 12);
  });

  it('keeps the text after two timestamps Whisper writes with no text between', async () => {
    const { words, ids } = vocabulary();
    const sentence = ids(' Turn', ' it', ' up.');
    // Transformers.js reads them as a part of the text, and decodes its tokens, which are none.
    const script: Script = (text, clip) =>
      text.length < 2 ? [at(text.length)] : follows(sentence)(text, clip);
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clipOf(5), 'en');
    expect(passes.map((p) => p.ids)).toEqual([[at(0), at(1), ...sentence]]);
    expect(out.text).toBe('Turn it up.');
  });

  it('gives scripts that take several tokens per character a larger token limit', async () => {
    const { words, ids } = vocabulary();
    const sentence = ids(...Array.from({ length: 60 }, (_, i) => `t${i} `));
    const hindi = fakeWhisper(words, follows(sentence));
    await transcribeClipChecked(hindi.asr, clipOf(2), 'hi');
    expect(hindi.passes.map((p) => [p.timestamps, p.maxNewTokens])).toEqual([[false, 116]]);
  });

  it('decodes a text the token limit cut off again with the whole budget, not with timestamps', async () => {
    const { words, ids } = vocabulary();
    const sentence = ids(...Array.from({ length: 60 }, (_, i) => `t${i} `));
    const { asr, passes } = fakeWhisper(words, follows(sentence));
    const out = await transcribeClipChecked(asr, clipOf(2), 'en');
    expect(passes.map((p) => [p.timestamps, p.maxNewTokens])).toEqual([
      [false, 52],
      [false, 444],
    ]);
    expect(out.text).toBe(words.join('').trim());
    expect(out.doubtful).toBe(true);
  });

  it('splits a long clip whose text was cut off at a loop and keeps the halves if they give more', async () => {
    const { words, ids } = vocabulary();
    const [go, bang, goLower] = ids(' Go', '!', ' go');
    const first = ids(' The', ' first', ' half', ' of', ' the', ' talk.');
    const second = ids(' And', ' the', ' second', ' half.');
    const clip = new Float32Array(10 * 16000).fill(0.5);
    clip.fill(0.2, 5 * 16000); // the quietest place to cut is the start of the second half
    const script: Script = (text, heard) => {
      if (heard.length === clip.length)
        return text.at(-1) === go || text.at(-1) === goLower ? [bang!] : [go!, goLower!];
      return follows(heard[0] === 0.5 ? first : second)(text, heard);
    };
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clip, 'en');
    expect(passes).toHaveLength(4);
    expect(out.text).toBe('The first half of the talk. And the second half.');
  });

  it('keeps the caption Whisper writes for a half that is only music out of the text, unless sure', async () => {
    const { words, ids } = vocabulary();
    const [go, bang, goLower] = ids(' Go', '!', ' go');
    const counted = ids(' Раз,', ' два,', ' три.');
    const caption = ids(' ДИНАМИЧНАЯ', ' МУЗЫКА');
    const clip = new Float32Array(10 * 16000).fill(0.5);
    clip.fill(0.2, 5 * 16000);
    const unsure: Script = (text, heard) =>
      text.length ? follows(caption)(text, heard) : [caption[0]!, END];
    for (const [music, kept] of [
      [unsure, 'Раз, два, три.'], // two choices at every step of the caption: -0.31
      [follows(caption), 'Раз, два, три. ДИНАМИЧНАЯ МУЗЫКА'], // one at its first: -0.16
    ] as const) {
      const script: Script = (text, heard) => {
        if (heard.length === clip.length)
          return text.at(-1) === go || text.at(-1) === goLower ? [bang!] : [go!, goLower!];
        return (heard[0] === 0.5 ? follows(counted) : music)(text, heard);
      };
      const { asr, passes } = fakeWhisper(words, script);
      const out = await transcribeClipChecked(asr, clip, 'ru');
      expect(passes.map((p) => p.text)).toContain(' ДИНАМИЧНАЯ МУЗЫКА');
      expect(out).toMatchObject({ text: kept, withCaptions: 'Раз, два, три. ДИНАМИЧНАЯ МУЗЫКА' });
    }
  });

  it('drops the captions of a clip over 30 s too, and gives the text with them', async () => {
    const said = ' Раз, два, три. ДИНАМИЧНАЯ МУЗЫКА [♪ OUTRO MUSIC PLAYING [♪';
    const asr = (async () => ({ text: said })) as unknown as AutomaticSpeechRecognitionPipeline;
    expect(await transcribeClipChecked(asr, clipOf(31), 'ru')).toMatchObject({
      text: 'Раз, два, три.',
      withCaptions: 'Раз, два, три. ДИНАМИЧНАЯ МУЗЫКА [ OUTRO MUSIC PLAYING [',
    });
  });

  it("weighs the halves with their captions and outros, so they don't tip the choice to a loop", async () => {
    const { words, ids } = vocabulary();
    const [go, on, bang, goLower] = ids(' Go', ' on', '!', ' go');
    // The clip's text is cut off at a loop: "Go on!" (6 characters).
    const chant: Script = (text) => {
      const last = text.at(-1);
      if (last === go || last === goLower) return [on!];
      return last === on ? [bang!] : [go!, goLower!];
    };
    const halves = [
      [ids(' Раз.'), ids(' ДИНАМИЧНАЯ', ' МУЗЫКА')],
      [ids(' 하나.'), ids(' 구독과', ' 좋아요', ' 부탁드립니다!')],
    ];
    for (const [said, music] of halves) {
      const clip = new Float32Array(10 * 16000).fill(0.5);
      clip.fill(0.2, 5 * 16000);
      // Two choices at every step of the music: Whisper is unsure of the outro (-0.31).
      const unsure: Script = (text, heard) =>
        text.length ? follows(music!)(text, heard) : [music![0]!, END];
      const script: Script = (text, heard) =>
        heard.length === clip.length
          ? chant(text, heard)
          : (heard[0] === 0.5 ? follows(said!) : unsure)(text, heard);
      const { asr, passes } = fakeWhisper(words, script);
      const out = await transcribeClipChecked(asr, clip, 'ru');
      expect(passes[0]!.text).toMatch(/^( Go on!){6}/);
      expect(out.text).toBe(words[said![0]!]!.trim());
    }
  });

  it('keeps a cut-off text if a half is cut off too', async () => {
    const { words, ids } = vocabulary();
    const [go, bang, goLower] = ids(' Go', '!', ' go');
    const second = ids(' And', ' the', ' second', ' half.');
    const clip = new Float32Array(10 * 16000).fill(0.5);
    clip.fill(0.2, 5 * 16000);
    const chant: Script = (text) =>
      text.at(-1) === go || text.at(-1) === goLower ? [bang!] : [go!, goLower!];
    const script: Script = (text, heard) =>
      heard.length === clip.length || heard[0] === 0.5 ? chant(text, heard) : follows(second)(text, heard);
    const { asr, passes } = fakeWhisper(words, script);
    const out = await transcribeClipChecked(asr, clip, 'en');
    expect(passes).toHaveLength(5); // the clip twice, its first half twice, its second half once
    expect(out.text).toBe('Go!');
  });
});
