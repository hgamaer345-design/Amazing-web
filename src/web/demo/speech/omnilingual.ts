// Meta's Omnilingual ASR 300M (CTC, 1,600+ languages; int8 ONNX export by sherpa-onnx), for
// languages Whisper transcribes poorly. Served from this site's /models/ folder. It hears the raw
// waveform (normalised to zero mean and unit variance, as sherpa-onnx does) and writes characters,
// with no punctuation or capital letters; it isn't told the language.
import * as ort from 'onnxruntime-web/webgpu';
import { joinTexts } from '../../../shared/text';
import {
  ALLOWED,
  ctcGreedy,
  CTC_SESSION_OPTIONS,
  fetchCtcModel,
  NOT_ALLOWED,
  REPLACEMENT,
  type OnnxSession,
} from './ctc';
import { ModelLoadError } from './models';
import type { ByteProgress, Recognizer } from './recognizer';
import { splitLongTurns } from './turns';

/** Approximate download size in MB (shown before downloading). */
export const OMNILINGUAL_MB = 365;

/** Folder under /models/ (see scripts/fetch-speech-models.mjs). */
export const OMNILINGUAL_DIR = 'omnilingual-300m-ctc-int8';

/**
 * Longest stretch of audio the model hears at once by default: a whole clip from the worker
 * (at most 30 s). Longer clips are cut at their quietest moments.
 */
export const OMNILINGUAL_MAX_SECONDS = 30;

/**
 * The same on phones. The model's working memory grows by ~10–15 MB per second of audio (its
 * convolutional front end runs at 16 kHz). In Chromium (one thread, heap capped at 768 MB like on
 * a phone) the WebAssembly heap held 429 MB after loading, 515 MB with 12 s pieces and 742 MB after
 * a whole 30 s clip, which leaves nothing for the other models sharing the heap. Cutting costs
 * some accuracy (FLEURS clips of 7–20 s: WER +0 to +7 points, e.g. Persian 17% -> 24%).
 */
export const OMNILINGUAL_LITE_MAX_SECONDS = 12;

export interface OmnilingualOptions {
  /** Longest stretch of audio heard at once (OMNILINGUAL_LITE_MAX_SECONDS on phones). */
  maxSeconds?: number;
}

/** Its convolutional front end needs at least 25 ms of audio. */
const MIN_SAMPLES = 400;

/** The clip scaled to zero mean and unit variance (a copy). */
export function normalizeWaveform(clip: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < clip.length; i++) mean += clip[i]!;
  mean /= clip.length || 1;
  let variance = 0;
  for (let i = 0; i < clip.length; i++) variance += (clip[i]! - mean) ** 2;
  variance /= clip.length || 1;
  const scale = 1 / Math.sqrt(variance + 1e-5);
  return clip.map((v) => (v - mean) * scale);
}

const SPECIAL = new Set(['<s>', '<pad>', '</s>', '<unk>']);

/** Text from the model's characters (" " is its word boundary): special tokens dropped, spaces collapsed. */
export function charsToText(chars: readonly string[]): string {
  return chars
    .filter((c) => !SPECIAL.has(c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first letter capitalised, so a row doesn't start in lower case (scripts without case are unchanged). */
export function capitalize(text: string): string {
  const first = text.codePointAt(0);
  if (first === undefined) return '';
  const head = String.fromCodePoint(first);
  return head.toUpperCase() + text.slice(head.length);
}

/**
 * The script a language is written in, for languages the model may write in another one: it isn't
 * told the language, and Hindi and Urdu (one spoken language) came out in each other's script in
 * one and three of six FLEURS clips. A text mostly in another script is decoded again from the same
 * scores with each letter replaced by the best one of this script (FLEURS Urdu: WER 78% -> 48%, CER
 * 74% -> 18%; Hindi: WER 36% -> 31%). Languages written in several scripts are left out.
 */
// prettier-ignore
export const LANGUAGE_SCRIPTS: Readonly<Record<string, string>> = {
  ar: 'Arabic', fa: 'Arabic', ur: 'Arabic', ps: 'Arabic', sd: 'Arabic', ug: 'Arabic',
  he: 'Hebrew', yi: 'Hebrew', hi: 'Devanagari', mr: 'Devanagari', ne: 'Devanagari', sa: 'Devanagari',
  bn: 'Bengali', as: 'Bengali', gu: 'Gujarati', or: 'Oriya', ta: 'Tamil', te: 'Telugu', kn: 'Kannada',
  ml: 'Malayalam', si: 'Sinhala', th: 'Thai', lo: 'Lao', km: 'Khmer', my: 'Myanmar', bo: 'Tibetan',
  ka: 'Georgian', hy: 'Armenian', am: 'Ethiopic', el: 'Greek',
  ru: 'Cyrillic', uk: 'Cyrillic', be: 'Cyrillic', bg: 'Cyrillic', mk: 'Cyrillic', kk: 'Cyrillic',
  ky: 'Cyrillic', tg: 'Cyrillic', mn: 'Cyrillic', tt: 'Cyrillic', ba: 'Cyrillic',
};

/** The other script the model writes these languages' speech in (Hindi and Urdu are one spoken language). */
const CONFUSED_SCRIPT: Readonly<Record<string, string>> = { Arabic: 'Devanagari', Devanagari: 'Arabic' };

/** One letter or mark of a script; Script_Extensions, so that shared marks (harakat) count for it. */
const scriptPattern = (script: string) => new RegExp(`^\\p{scx=${script}}$`, 'u');
const LETTER = /[\p{L}\p{M}]/gu;

/** Whether at least half the letters of `text` are in `script` (true when it has none). */
export function isMostlyInScript(text: string, script: string): boolean {
  const letters = text.match(LETTER) ?? [];
  const pattern = scriptPattern(script);
  return letters.filter((c) => pattern.test(c)).length * 2 >= letters.length;
}

/**
 * For ctcGreedy: tokens without letters (the space, digits, punctuation) are allowed, letters of
 * `script` also replace letters of other scripts.
 */
export function scriptMask(tokens: readonly string[], script: string): Uint8Array {
  const pattern = scriptPattern(script);
  return Uint8Array.from(tokens, (t) => {
    const letters = t.match(LETTER) ?? [];
    if (letters.length === 0) return ALLOWED;
    return letters.every((c) => pattern.test(c)) ? REPLACEMENT : NOT_ALLOWED;
  });
}

/** The recognizer around a created session and the model's token table. */
export function createOmnilingual(
  session: OnnxSession,
  tokens: readonly string[],
  Tensor: typeof ort.Tensor = ort.Tensor,
  maxSeconds = OMNILINGUAL_MAX_SECONDS,
): Recognizer {
  const masks = new Map<string, Uint8Array>();
  const decode = async (piece: Float32Array, script: string | undefined): Promise<string> => {
    if (piece.length < MIN_SAMPLES) return '';
    const out = await session.run({ x: new Tensor('float32', normalizeWaveform(piece), [1, piece.length]) });
    const logits = out.logits!;
    const [, frames = 0, vocab = 0] = logits.dims;
    const scores = logits.data as Float32Array;
    let text = charsToText(ctcGreedy(scores, frames, vocab, 0).map((id) => tokens[id] ?? ''));
    if (script && !isMostlyInScript(text, script) && isMostlyInScript(text, CONFUSED_SCRIPT[script] ?? '')) {
      // Written in the script of a sister language (Urdu in Devanagari, Hindi in Arabic letters): the
      // best reading in the language's own, from the same scores. Text in any other script means the
      // speech isn't in this language at all (a wrong label), and forcing letters would make nonsense.
      let mask = masks.get(script);
      if (!mask) masks.set(script, (mask = scriptMask(tokens, script)));
      text = charsToText(ctcGreedy(scores, frames, vocab, 0, mask).map((id) => tokens[id] ?? ''));
    }
    logits.dispose?.();
    return text;
  };
  return {
    id: 'omnilingual',
    label: 'Omnilingual ASR',
    async transcribe(clip, language) {
      const pieces = splitLongTurns(clip, [{ speaker: 0, start: 0, end: clip.length }], {
        maxSeconds,
        searchSeconds: maxSeconds / 3,
      });
      const script = LANGUAGE_SCRIPTS[language];
      const texts: string[] = [];
      for (const p of pieces) texts.push(await decode(clip.subarray(p.start, p.end), script));
      const text = joinTexts(texts);
      // On noise it writes nothing, or a lone letter (3 of 16 noise and silence clips).
      return (text.match(LETTER)?.length ?? 0) < 2 ? '' : capitalize(text);
    },
    dispose: () => session.release(),
  };
}

export async function loadOmnilingual(
  onProgress: ByteProgress,
  options: OmnilingualOptions = {},
): Promise<Recognizer> {
  let files;
  try {
    files = await fetchCtcModel(OMNILINGUAL_DIR, onProgress);
  } catch (err) {
    throw new ModelLoadError('download', err instanceof Error ? err.message : String(err));
  }
  try {
    const session = await ort.InferenceSession.create(files.model, {
      ...CTC_SESSION_OPTIONS,
      externalData: files.externalData,
    });
    return createOmnilingual(session, files.tokens, ort.Tensor, options.maxSeconds);
  } catch (err) {
    throw new ModelLoadError('load', err instanceof Error ? err.message : String(err));
  }
}
