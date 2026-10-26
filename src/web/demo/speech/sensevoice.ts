// SenseVoice-Small (FunAudioLLM; int8 ONNX export by sherpa-onnx), a CTC model that beats Whisper
// Small on Chinese, Cantonese, Japanese and Korean. Served from this site's /models/ folder.
// The pipeline is sherpa-onnx's: Kaldi fbank as FunASR computes it, 7 frames stacked every 6
// (LFR), the model's CMVN, then one encoder pass whose first four outputs are tags (language,
// emotion, audio event, text normalisation) and the rest the text, decoded greedily.
import * as ort from 'onnxruntime-web/webgpu';
import { ctcGreedy, CTC_SESSION_OPTIONS, fetchCtcModel, onnxMetadata, type OnnxSession } from './ctc';
import { computeFbank, FBANK, SENSEVOICE_FBANK } from './fbank';
import { ModelLoadError } from './models';
import type { ByteProgress, Recognizer } from './recognizer';

/** Languages SenseVoice transcribes well (it also does English, where Whisper is used instead). */
export const SENSEVOICE_LANGUAGES = ['zh', 'yue', 'ja', 'ko'] as const;

/** Approximate download size in MB (shown before downloading). */
export const SENSEVOICE_MB = 240;

/** Folder under /models/ (see scripts/fetch-speech-models.mjs). */
export const SENSEVOICE_DIR = 'sensevoice-small-int8';

/** Languages the model can be told to expect; anything else is left to its own detection. */
const PROMPT_LANGUAGES = ['zh', 'en', 'yue', 'ja', 'ko'] as const;

/** What sherpa-onnx's export stores in the model's metadata. */
export interface SenseVoiceSettings {
  lfrWindow: number;
  lfrShift: number;
  negMean: Float32Array;
  invStddev: Float32Array;
  /** Prompt ids: "auto" and the languages above. */
  languageIds: Record<string, number>;
  withItn: number;
}

function numbers(text: string | undefined, name: string): Float32Array {
  const values = (text ?? '').split(',').map(Number);
  if (values.length === 0 || values.some((v) => !Number.isFinite(v)))
    throw new Error(`Bad SenseVoice ${name}`);
  return Float32Array.from(values);
}

export function senseVoiceSettings(meta: Record<string, string>): SenseVoiceSettings {
  const lfrWindow = Number(meta.lfr_window_size);
  const lfrShift = Number(meta.lfr_window_shift);
  const negMean = numbers(meta.neg_mean, 'neg_mean');
  const invStddev = numbers(meta.inv_stddev, 'inv_stddev');
  if (
    !(lfrWindow > 0 && lfrShift > 0) ||
    negMean.length !== lfrWindow * FBANK.numBins ||
    invStddev.length !== negMean.length ||
    meta.normalize_samples !== '0'
  ) {
    throw new Error('Unexpected SenseVoice model settings');
  }
  const languageIds: Record<string, number> = { auto: Number(meta.lang_auto ?? 0) };
  for (const code of PROMPT_LANGUAGES) {
    const id = Number(meta[`lang_${code}`]);
    if (Number.isInteger(id)) languageIds[code] = id;
  }
  return { lfrWindow, lfrShift, negMean, invStddev, languageIds, withItn: Number(meta.with_itn ?? 14) };
}

/**
 * Low frame rate stacking: output frame t holds input frames 6t-3 … 6t+3 (for 7/6), the first
 * and last frame repeated past the ends; ceil(frames / shift) output frames.
 */
export function stackFrames(
  feats: Float32Array,
  dim: number,
  window: number,
  shift: number,
): { data: Float32Array; frames: number } {
  const inFrames = feats.length / dim;
  if (inFrames === 0) return { data: new Float32Array(0), frames: 0 };
  const frames = Math.ceil(inFrames / shift);
  const data = new Float32Array(frames * window * dim);
  const left = Math.floor((window - 1) / 2);
  for (let t = 0; t < frames; t++) {
    for (let j = 0; j < window; j++) {
      const src = Math.min(Math.max(t * shift - left + j, 0), inFrames - 1);
      data.set(feats.subarray(src * dim, (src + 1) * dim), (t * window + j) * dim);
    }
  }
  return { data, frames };
}

/** (x + negMean) · invStddev per dimension, in place. */
export function applyCmvn(data: Float32Array, negMean: Float32Array, invStddev: Float32Array): Float32Array {
  const dim = negMean.length;
  for (let i = 0; i < data.length; i++) {
    const d = i % dim;
    data[i] = (data[i]! + negMean[d]!) * invStddev[d]!;
  }
  return data;
}

/** Model input for a 16 kHz clip: frames × (window · 80). */
export function senseVoiceFeatures(
  clip: Float32Array,
  settings: SenseVoiceSettings,
): { data: Float32Array; frames: number } {
  const fbank = computeFbank(clip, 32768, SENSEVOICE_FBANK);
  const stacked = stackFrames(fbank, FBANK.numBins, settings.lfrWindow, settings.lfrShift);
  applyCmvn(stacked.data, settings.negMean, settings.invStddev);
  return stacked;
}

/** Han, kana and CJK / full-width punctuation: written without spaces (Hangul keeps them). */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー\\u3000-\\u303f\\uff01-\\uff60';
// Also next to digits, which the model's number formatting surrounds with spaces ("1 日に", "18 個").
const SPACE_NEAR_CJK = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}\\d])|(?<=[${CJK}\\d])\\s+(?=[${CJK}])`, 'gu');

/**
 * Text from SentencePiece pieces ("▁" starts a word): spaces only where words begin, none between
 * Chinese or Japanese characters (or digits next to them) or before punctuation.
 */
export function piecesToText(pieces: readonly string[]): string {
  return pieces
    .join('')
    .replace(/▁/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(SPACE_NEAR_CJK, '')
    .replace(/\s+(?=[,.!?;:%)\]}，。！？；：、）」』】])/gu, '')
    .trim();
}

const TAG = /^<\|(.*)\|>$/;
const EVENT = /^(Speech|BGM|Laughter|Applause|Cry|Sneeze|Breath|Cough|Sing|Speech_Noise|Event_UNK)$/;

export interface SenseVoiceText {
  text: string;
  /** Language tag the model output ("zh", "en", "yue", "ja", "ko", …); null for no speech. */
  language: string | null;
  /** Audio event tag, e.g. "Speech", "BGM", "Laughter". */
  event: string | null;
}

/**
 * Splits decoded ids into the leading tags (language, emotion, event, text normalisation) and the
 * text; tags elsewhere are dropped.
 */
export function readSenseVoiceOutput(ids: readonly number[], tokens: readonly string[]): SenseVoiceText {
  const tags: string[] = [];
  let i = 0;
  for (; i < ids.length && tags.length < 4; i++) {
    const tag = TAG.exec(tokens[ids[i]!] ?? '');
    if (!tag) break;
    tags.push(tag[1]!);
  }
  const pieces = ids
    .slice(i)
    .map((id) => tokens[id] ?? '')
    .filter((piece) => !TAG.test(piece) && piece !== '<unk>' && piece !== '<s>' && piece !== '</s>');
  const language = tags[0] && tags[0] !== 'nospeech' && /^[a-z/]+$/.test(tags[0]) ? tags[0] : null;
  const text = language ? piecesToText(pieces) : '';
  return {
    // On noise and silence it writes just "。" or ".".
    text: /[\p{L}\p{N}]/u.test(text) ? text : '',
    language,
    event: tags.find((t) => EVENT.test(t)) ?? null,
  };
}

export interface SenseVoiceRecognizer extends Recognizer {
  /**
   * Text and the language SenseVoice heard (it tells Cantonese from Mandarin, which Whisper
   * Tiny–Small can't: they call both "zh"). `language` is a hint; "auto" or another code lets it
   * decide.
   */
  recognize(clip: Float32Array, language: string): Promise<SenseVoiceText>;
}

/** The recognizer around a created session, the model's metadata and its token table. */
export function createSenseVoice(
  session: OnnxSession,
  metadata: Record<string, string>,
  tokens: readonly string[],
  Tensor: typeof ort.Tensor = ort.Tensor,
): SenseVoiceRecognizer {
  const settings = senseVoiceSettings(metadata);
  const recognize = async (clip: Float32Array, language: string): Promise<SenseVoiceText> => {
    const { data, frames } = senseVoiceFeatures(clip, settings);
    if (frames === 0) return { text: '', language: null, event: null };
    const prompt = settings.languageIds[language] ?? settings.languageIds.auto!;
    const out = await session.run({
      x: new Tensor('float32', data, [1, frames, settings.lfrWindow * FBANK.numBins]),
      x_length: new Tensor('int32', Int32Array.from([frames]), [1]),
      language: new Tensor('int32', Int32Array.from([prompt]), [1]),
      text_norm: new Tensor('int32', Int32Array.from([settings.withItn]), [1]),
    });
    const logits = out.logits!;
    const [, steps = 0, vocab = 0] = logits.dims;
    const ids = ctcGreedy(logits.data as Float32Array, steps, vocab, 0);
    logits.dispose?.();
    return readSenseVoiceOutput(ids, tokens);
  };
  return {
    id: 'sensevoice',
    label: 'SenseVoice',
    recognize,
    transcribe: async (clip, language) => (await recognize(clip, language)).text,
    dispose: () => session.release(),
  };
}

export async function loadSenseVoice(onProgress: ByteProgress): Promise<SenseVoiceRecognizer> {
  let files;
  try {
    files = await fetchCtcModel(SENSEVOICE_DIR, onProgress);
  } catch (err) {
    throw new ModelLoadError('download', err instanceof Error ? err.message : String(err));
  }
  try {
    const metadata = onnxMetadata(files.model);
    const session = await ort.InferenceSession.create(files.model, {
      ...CTC_SESSION_OPTIONS,
      externalData: files.externalData,
    });
    return createSenseVoice(session, metadata, files.tokens);
  } catch (err) {
    throw new ModelLoadError('load', err instanceof Error ? err.message : String(err));
  }
}
