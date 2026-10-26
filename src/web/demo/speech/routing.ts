// Which speech-to-text model transcribes which language, and how a speaker's language is decided.
// Pure functions: the worker (speech.worker.ts) does the loading and the transcribing.
import { baseLanguage } from '../../../shared/languages';
import type { QualityMode } from '../../../shared/types';
import type { RecognizerId } from './recognizer';

export type WhisperId = Extract<RecognizerId, `whisper-${string}`>;

/** Whisper sizes, smallest first. */
export const WHISPER_IDS: readonly WhisperId[] = ['whisper-tiny', 'whisper-base', 'whisper-small'];

/** The Whisper size each quality mode starts from (the least any language gets). */
export const QUALITY_WHISPER: Record<QualityMode, WhisperId> = {
  standard: 'whisper-tiny',
  high: 'whisper-base',
  ultra: 'whisper-small',
};

/**
 * Largest Whisper a phone runs. Base needs about 450 MB of WebAssembly memory while it
 * transcribes; Small, with three times the weights and twice the layers, would not fit the 768 MB
 * heap the worker allows itself on phones (speech.worker.ts), and iOS kills the whole tab at
 * ~1–1.5 GB.
 */
export const LITE_MAX_WHISPER: WhisperId = 'whisper-base';

/**
 * Whether phones may use SenseVoice and Omnilingual ASR. Both are a single encoder pass per clip
 * (no decoder loop or cross-attention cache), so they need far less working memory than their
 * download size suggests; turn this off if they don't fit a phone's tab.
 */
export const LITE_USES_CTC_MODELS = true;

/** Languages SenseVoice transcribes better than Whisper Small (same as sensevoice.ts). */
export const SENSEVOICE_ROUTED: readonly string[] = ['zh', 'yue', 'ja', 'ko'];

/**
 * Whisper's word error rate (%) on FLEURS for tiny, base and small (Radford et al. 2022, table
 * D.2.4; character error rate for languages written without spaces), by Whisper language code.
 */
// prettier-ignore
export const FLEURS_WER: Readonly<Record<string, readonly [number, number, number]>> = {
  en: [12.4, 8.9, 6.1], zh: [40.5, 34.1, 20.8], de: [27.8, 17.9, 10.2], es: [15.9, 9.9, 5.6],
  ru: [31.1, 20.5, 11.4], ko: [36.1, 27.8, 19.6], fr: [41.4, 28.5, 15.0], ja: [37.0, 22.8, 12.0],
  pt: [20.1, 13.0, 7.3], tr: [42.5, 27.5, 15.9], pl: [45.6, 30.8, 14.7], ca: [42.8, 29.0, 16.2],
  nl: [49.0, 33.0, 16.4], ar: [63.4, 48.8, 30.6], sv: [52.7, 37.4, 20.8], it: [29.8, 17.9, 9.8],
  id: [51.7, 33.1, 16.3], hi: [102.3, 101.1, 38.4], fi: [59.5, 43.1, 24.0], vi: [60.0, 40.5, 21.2],
  he: [71.6, 61.7, 44.4], uk: [51.2, 37.7, 19.3], el: [67.4, 53.5, 30.8], ms: [51.2, 35.1, 18.9],
  cs: [82.8, 66.0, 37.6], ro: [74.7, 56.0, 29.8], da: [82.0, 57.6, 32.8], hu: [83.8, 65.0, 38.9],
  ta: [99.9, 58.7, 35.2], no: [62.0, 44.0, 24.2], th: [58.8, 38.2, 21.9], ur: [65.2, 52.0, 37.3],
  hr: [79.0, 59.1, 33.4], bg: [81.0, 65.1, 37.3], lt: [98.5, 87.3, 65.6], mi: [94.5, 77.5, 59.5],
  ml: [101.5, 107.4, 100.9], cy: [101.3, 85.3, 59.3], sk: [77.2, 60.6, 33.3], te: [105.1, 105.2, 98.2],
  fa: [101.8, 86.1, 55.8], lv: [91.6, 79.8, 53.2], bn: [101.6, 100.6, 104.4], sr: [83.7, 64.3, 42.2],
  az: [93.1, 76.4, 49.1], sl: [87.2, 74.6, 49.3], kn: [100.7, 107.2, 100.4], et: [94.8, 77.9, 51.3],
  mk: [73.3, 59.9, 36.9], is: [113.3, 95.5, 72.6], hy: [118.6, 126.3, 86.6], ne: [101.8, 102.4, 69.5],
  mn: [113.7, 125.7, 144.2], bs: [82.1, 66.7, 39.4], kk: [165.2, 109.2, 70.3], sw: [100.9, 92.5, 73.7],
  gl: [54.8, 47.4, 30.2], mr: [100.3, 100.3, 60.2], pa: [102.6, 101.5, 103.6], km: [100.6, 101.6, 104.4],
  sn: [128.1, 126.0, 140.0], yo: [106.4, 101.8, 116.4], so: [105.6, 109.6, 105.3], af: [91.2, 81.5, 61.1],
  oc: [95.9, 82.9, 87.3], ka: [123.0, 114.7, 118.3], be: [94.0, 91.3, 75.1], tg: [101.7, 109.3, 84.3],
  sd: [105.8, 103.9, 131.7], gu: [101.2, 101.4, 106.4], am: [122.9, 196.8, 120.2],
  lo: [115.1, 105.1, 102.2], uz: [105.2, 114.0, 107.7], ps: [105.6, 99.0, 92.9], mt: [100.8, 97.6, 92.2],
  lb: [99.1, 100.7, 100.1], my: [124.8, 122.6, 110.1], tl: [65.6, 45.8, 27.7], as: [102.0, 102.0, 108.0],
  ln: [105.4, 96.7, 91.3], ha: [100.2, 98.6, 90.1], jw: [107.3, 89.5, 88.6],
};

/**
 * Languages where Whisper Small did as well as or better than Omnilingual ASR on FLEURS clips
 * (Urdu 43 vs 48 % WER, Hebrew 45 vs 45 %, and Whisper keeps punctuation): Small is used for them
 * where the device runs it, although its FLEURS figure is above POOR_WER.
 */
export const WHISPER_SMALL_PREFERRED: readonly string[] = ['ur', 'he'];

/** A Whisper size is good enough for a language at or below this FLEURS error rate (%)… */
export const GOOD_WER = 20;
/** …and worse than Omnilingual ASR above this one. */
export const POOR_WER = 30;

const whisperIndex = (id: WhisperId) => WHISPER_IDS.indexOf(id);

/** The largest Whisper this device runs. */
export function maxWhisper(lite: boolean): WhisperId {
  return lite ? LITE_MAX_WHISPER : 'whisper-small';
}

/** The quality mode's Whisper, within what the device runs: it also detects the languages. */
export function qualityWhisper(quality: QualityMode, lite: boolean): WhisperId {
  const wanted = QUALITY_WHISPER[quality];
  const max = maxWhisper(lite);
  return whisperIndex(wanted) > whisperIndex(max) ? max : wanted;
}

export function isWhisper(id: RecognizerId): id is WhisperId {
  return (WHISPER_IDS as readonly string[]).includes(id);
}

/**
 * The model for speech in `language` (ISO 639-1 as Whisper spells it, or "yue"):
 * - Chinese, Cantonese, Japanese and Korean go to SenseVoice;
 * - English uses the quality mode's Whisper;
 * - other languages get the smallest Whisper whose FLEURS error rate is at most GOOD_WER, but never
 *   Tiny (good only for English and Spanish, and its language detection and hallucination checks
 *   are weakest away from English) and never less than the quality mode's;
 * - where even the largest Whisper this device runs stays above POOR_WER (or FLEURS has no figure:
 *   Whisper saw almost no training data for those), Omnilingual ASR; else that Whisper.
 */
export function chooseRecognizer(
  language: string,
  quality: QualityMode,
  lite = false,
  ctcOnLite = LITE_USES_CTC_MODELS,
): RecognizerId {
  const code = language.toLowerCase();
  const ctc = !lite || ctcOnLite;
  const max = maxWhisper(lite);
  const least = qualityWhisper(quality, lite);
  if (SENSEVOICE_ROUTED.includes(code) && ctc) return 'sensevoice';
  if (code === 'en') return least;
  const wer = FLEURS_WER[code === 'yue' ? 'zh' : code];
  if (wer) {
    const from = Math.max(whisperIndex(least), whisperIndex('whisper-base'));
    for (let i = from; i <= whisperIndex(max); i++) if (wer[i]! <= GOOD_WER) return WHISPER_IDS[i]!;
    if (wer[whisperIndex(max)]! <= POOR_WER || !ctc) return max;
    if (max === 'whisper-small' && WHISPER_SMALL_PREFERRED.includes(code)) return max;
  }
  return ctc ? 'omnilingual' : max;
}

/**
 * What to use instead when `id` can't be loaded: the largest Whisper the device runs for the
 * other models, then the Whisper that was already running (`known`, which loaded fine).
 */
export function fallbackRecognizer(id: RecognizerId, known: WhisperId, lite: boolean): WhisperId | null {
  if (!isWhisper(id)) return maxWhisper(lite);
  return id === known ? null : known;
}

/** Whisper's code for a language: it has no separate Cantonese (only large-v3 does). */
export function whisperLanguage(code: string): string {
  return code === 'yue' ? 'zh' : code;
}

/**
 * Relative cost of a second of speech per model, for progress: Whisper Tiny/Base/Small as measured
 * in Chromium (see SPEAKERS_SHARE in speech.worker.ts), the CTC models from their speed relative
 * to Whisper in onnxruntime-node (one pass per clip, but larger encoders).
 */
export const RECOGNIZER_COST: Record<RecognizerId, number> = {
  'whisper-tiny': 1,
  'whisper-base': 1.9,
  'whisper-small': 4.6,
  sensevoice: 1,
  omnilingual: 4,
};

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

export interface LanguageGuess {
  /** The most likely language (Whisper's code). */
  code: string;
  probability: number;
  /** The most likely languages, best first. */
  ranked: { code: string; probability: number }[];
}

/**
 * Whisper's language probabilities: a softmax over the language tokens' scores only (as
 * openai/whisper's detect_language), best first, keeping the `top` most likely.
 */
export function rankLanguages(scores: readonly { code: string; score: number }[], top = 5): LanguageGuess {
  if (scores.length === 0) return { code: 'en', probability: 1, ranked: [{ code: 'en', probability: 1 }] };
  const max = Math.max(...scores.map((s) => s.score));
  const sum = scores.reduce((n, s) => n + Math.exp(s.score - max), 0);
  const ranked = scores
    .map((s) => ({ code: s.code, probability: Math.exp(s.score - max) / sum }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, top);
  return { code: ranked[0]!.code, probability: ranked[0]!.probability, ranked };
}

/** Whisper's language detection was right every time it was at least this sure (30 clips × 3 sizes). */
export const LID_CONFIDENT = 0.8;
/**
 * A speaker with less speech than this whose detection is unsure takes the whole recording's
 * language: on 4–7 s clips, unsure detections (p < 0.8) were wrong 3 times in 7 (Whisper Tiny).
 */
export const LID_MIN_SECONDS = 10;
/** Less speech than this isn't worth a detection of its own. */
export const LID_MIN_SAMPLE_SECONDS = 1;
/** A doubtful Whisper clip at least this long has its language detected again. */
export const RECHECK_MIN_SECONDS = 3;

/** Whether a speaker's language needs the whole recording's detection (see `speakerLanguage`). */
export function needsOverall(own: LanguageGuess | null, seconds: number): boolean {
  return !own || (own.probability < LID_CONFIDENT && seconds < LID_MIN_SECONDS);
}

/**
 * A speaker's language: their own detection (on up to 30 s of their speech) when it is sure or
 * rests on enough speech, otherwise the detection on the whole recording's first 30 s of speech.
 */
export function speakerLanguage(own: LanguageGuess | null, seconds: number, overall: LanguageGuess): string {
  return needsOverall(own, seconds) ? overall.code : own!.code;
}

/** A turn's re-detected language when it should replace `current` (another language, and sure). */
export function recheckedLanguage(current: string, guess: LanguageGuess): string | null {
  return guess.code !== current && guess.probability >= LID_CONFIDENT ? guess.code : null;
}

/** The language with the most speech (ties: the one heard first), or null for none. */
export function mainLanguage(
  parts: readonly { lang?: string; startMs: number; endMs: number }[],
): string | null {
  const totals = new Map<string, number>();
  for (const p of parts) if (p.lang) totals.set(p.lang, (totals.get(p.lang) ?? 0) + (p.endMs - p.startMs));
  let best: string | null = null;
  for (const [lang, ms] of totals) if (best === null || ms > totals.get(best)!) best = lang;
  return best;
}

// ---------------------------------------------------------------------------
// Words for progress messages
// ---------------------------------------------------------------------------

let names: Intl.DisplayNames | null | undefined;

/** "French" for "fr" (in English, the interface's language); the code itself if unknown. */
export function languageName(code: string): string {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      names = null;
    }
  }
  const base = baseLanguage(code) ?? code;
  try {
    const name = names?.of(base);
    return name && name !== base ? name : code;
  } catch {
    return code;
  }
}

/** "French", "French and German", "Arabic, Hindi and Persian". */
export function listNames(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "French (2 speakers) and English (1 speaker)"; just "French" for a single speaker. */
export function describeSpeakerLanguages(languages: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const l of languages) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (languages.length === 1) return languageName(languages[0]!);
  const ordered = [...counts].sort((a, b) => b[1] - a[1]);
  return listNames(ordered.map(([l, n]) => `${languageName(l)} (${n} speaker${n === 1 ? '' : 's'})`));
}
