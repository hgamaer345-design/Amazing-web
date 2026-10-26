// Clean-up of Whisper's text for one clip, and the checks that keep Whisper's hallucinations
// (text invented for noise, silence or unclear audio) out of the transcript.
import { joinTexts } from '../../../shared/text';

/**
 * Whisper's usual output for non-speech: sound tags ("[Music]", "【音楽】", "(laughs)", "（拍手）",
 * "♪", "♪～") and nothing else. Brackets and notes always go; parentheses also hold real speech
 * ("2020年(令和2年)"), so those go only when `isSoundTag` says so.
 */
const SOUND_TAGS = /\[[^\]]*\]|［[^］]*］|【[^】]*】|[~～〜]*[♪♫♬]+[~～〜]*|\([^)]*\)|（[^）]*）/g;

/** Words of the sound tags Whisper writes in parentheses, in the languages it writes them most. */
const SOUND_WORDS = new RegExp(
  [
    // Latin and Cyrillic stems start a word: "(Risas)", not "(Larisa)" (no lookbehind: older Safari).
    '(?:^|\\P{L})(?:laugh|chuckl|giggl|applau|music|cheer|clap|cough|sigh|sniff|gasp|groan|scream|whisper',
    'mumbl|inaudible|indistinct|unintelligible|crosstalk|silence|noise|static|beep|breath|sobs|crying',
    'risa|aplauso|música|rire|applaudissement|musique|lach|musik|risate|applausi|musica|risos',
    'смех|аплодисмент|музык|śmiech|oklaski|muzyk|gelach|muziek|kahkaha|alkış|müzik)',
    '笑|拍手|音楽|音乐|掌声|歓声|웃음|박수|음악|ضحك|تصفيق|موسيق|צחוק|מחיאות|מוזיקה|हँसी|तालियाँ|संगीत',
  ].join('|'),
  'iu',
);

/**
 * Whether a parenthesised group of Whisper's text is a sound tag rather than speech: short, no
 * digits, and either a known sound word or alone at the start or end of the clip, where Whisper
 * puts the tags it writes for laughter or music it has no word for ("(door closes)").
 */
function isSoundTag(group: string, before: string, after: string): boolean {
  const inner = group.slice(1, -1).trim();
  if (/\p{N}/u.test(inner) || inner.length > 40 || inner.split(/\s+/).length > 5) return false;
  const alone = (side: string) => side.replace(SOUND_TAGS, '').trim() === '';
  return SOUND_WORDS.test(inner) || alone(before) || alone(after);
}

/** Scripts written without spaces between words, where a loop has no spaces to find it by. */
const UNSPACED_RUN =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\u3000-\u303f\uff01-\uff60]{8,}/gu;

let graphemeSegmenter: Intl.Segmenter | null | undefined;

/** The text's user-perceived characters (a Thai or Hindi letter with its vowel signs is one). */
function graphemes(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
  }
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (s) => s.segment) : [...text];
}

/**
 * Collapses loops inside text written without spaces ("谢谢谢谢谢谢…"), measured in characters as
 * `collapseRepeats` measures words: a piece of 3+ characters repeated 4+ times in a row, or of 1–2
 * characters 8+ times. A single character keeps two copies, since such words are often doubled
 * ("谢谢", "哈哈").
 */
function collapseUnspaced(run: string): string {
  const chars = graphemes(run);
  const same = (a: number, b: number, n: number) => {
    for (let k = 0; k < n; k++) if (chars[a + k] !== chars[b + k]) return false;
    return true;
  };
  for (let n = 1; n <= 40; n++) {
    const minReps = n <= 2 ? 8 : 4;
    const keep = n === 1 ? 2 : 1;
    for (let i = 0; i + n * minReps <= chars.length; i++) {
      let reps = 1;
      while (i + (reps + 1) * n <= chars.length && same(i, i + reps * n, n)) reps++;
      if (reps >= minReps) chars.splice(i + keep * n, (reps - keep) * n);
    }
  }
  return chars.join('');
}

/**
 * Collapses Whisper's repetition loops to one copy: a phrase of 2+ words repeated 4+ times in a
 * row, or a single word repeated 8+ times ("Ah, ah, ah, …" on a laugh); likewise inside Chinese,
 * Japanese or Thai text, which has no spaces (see `collapseUnspaced`). Ordinary repetition
 * ("no, no, no", "very very very very good") is left alone.
 */
export function collapseRepeats(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  // Marks count: Hindi कम ("less") and काम ("work") differ only by a vowel sign.
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, '');
  for (let n = 1; n <= 8; n++) {
    const minReps = n === 1 ? 8 : 4;
    for (let i = 0; i + n * minReps <= words.length; i++) {
      let reps = 1;
      while (
        i + (reps + 1) * n <= words.length &&
        words.slice(i, i + n).every((w, k) => key(w) === key(words[i + reps * n + k]!))
      ) {
        reps++;
      }
      if (reps >= minReps) words.splice(i + n, (reps - 1) * n);
    }
  }
  return words.join(' ').replace(UNSPACED_RUN, collapseUnspaced);
}

/** Cleans Whisper's text for a clip: drops sound tags, lone "you" hallucinations and loops. */
export function cleanTranscript(text: string, clipSeconds: number): string {
  const pieces: string[] = [];
  let at = 0;
  for (const m of text.matchAll(SOUND_TAGS)) {
    const tag = m[0];
    const end = m.index + tag.length;
    if (/^[(（]/.test(tag) && !isSoundTag(tag, text.slice(0, m.index), text.slice(end))) continue;
    pieces.push(text.slice(at, m.index));
    at = end;
  }
  pieces.push(text.slice(at));
  // Joined as written: no space where a tag sat between two pieces of Chinese or Japanese.
  let out = joinTexts(pieces).replace(/\s+/g, ' ').trim();
  // A lone "you" on a very short clip is Whisper's classic output for a breath or a noise.
  if (clipSeconds < 2 && /^you[.!]?$/i.test(out)) out = '';
  return collapseRepeats(out);
}

/** A text token Whisper chose and its log-probability (natural log). */
export interface ScoredToken {
  id: number;
  text: string;
  logprob: number;
}

/** One Whisper decode of a clip, with the evidence used to judge it. */
export interface ClipDecode {
  /** Whisper's text as returned by Transformers.js. */
  text: string;
  /** The text tokens in order (no special or timestamp tokens). */
  tokens: ScoredToken[];
  /** Log-probability of the end-of-text token, or null when the token limit cut the text off. */
  endLogprob: number | null;
  /**
   * Probability of <|nocaptions|> right after <|startoftranscript|>: Whisper's own "nobody is
   * speaking" signal (openai/whisper's no_speech_prob).
   */
  noSpeechProb: number;
  /** Turns token ids back into text (the tokenizer's decode). */
  detokenize(ids: number[]): string;
}

/**
 * Thresholds, measured with Whisper Tiny/Base on real recordings (a 5.5 min interview, meeting and
 * earnings-call excerpts), synthetic conversations and real background noise; see
 * docs/ARCHITECTURE.md. openai/whisper's defaults are logprob -1.0, no-speech 0.6, compression 2.4.
 */
export const HALLUCINATION_LIMITS = {
  /** A decode below this average log-probability is decoded again (openai/whisper: -1)… */
  retryLogprob: -1,
  /** …and the clip dropped if neither decode reaches this. */
  minLogprob: -1.2,
  /** No-speech probability above which a clip counts as silent… */
  noSpeech: 0.6,
  /** …when its average log-probability is also below this. */
  noSpeechLogprob: -1,
  /** A known hallucination phrase ending a clip is kept only if its tokens average at least this. */
  phraseLogprob: -0.3,
  /** A token pattern of up to this many tokens repeating back to back is a loop… */
  loopMaxPeriod: 64,
  /** …once the repeats cover at least this many tokens (and the pattern occurs 3+ times). */
  loopMinTokens: 16,
  /** A sentence of at least this many tokens said three times in one clip is a loop too. */
  loopSentenceTokens: 4,
} as const;

export type HallucinationLimits = { [K in keyof typeof HALLUCINATION_LIMITS]: number };

/**
 * Phrases Whisper produces for silence, music and noise: subtitle credits and video outros from
 * its training data (the "bag of hallucinations" of Barański et al., ICASSP 2025; the
 * openai/whisper discussions) and what we saw on pauses and background noise ("Thank you.",
 * "Thanks for watching."). Compared after `normalizePhrase`.
 */
export const HALLUCINATION_PHRASES = [
  'Thank you for watching',
  'Thanks for watching',
  'Thank you so much for watching',
  'Thank you very much for watching',
  'Thanks for watching and see you next time',
  'See you next time',
  'See you in the next video',
  'See you in the next one',
  "I'll see you in the next video",
  'Please subscribe',
  'Please subscribe to my channel',
  'Subscribe to my channel',
  'Like and subscribe',
  'Please like and subscribe',
  "Don't forget to like and subscribe",
  "Don't forget to subscribe",
  'Thank you',
  'Thank you very much',
  'Thank you so much',
  'Thanks',
  'Bye',
  'Bye bye',
  'Goodbye',
  'The end',
  'You',
  'Subtitles by the Amara.org community',
  'Subtitles by',
  'Transcription by CastingWords',
  'Untertitel der Amara.org-Community',
  'Untertitel im Auftrag des ZDF',
  'Vielen Dank fürs Zuschauen',
  "Sous-titres réalisés para la communauté d'Amara.org",
  "Sous-titres réalisés par la communauté d'Amara.org",
  "Merci d'avoir regardé",
  'Subtítulos realizados por la comunidad de Amara.org',
  'Gracias por ver',
  'Gracias por ver el video',
  'Legendas pela comunidade Amara.org',
  'Obrigado por assistir',
  'Sottotitoli creati dalla comunità Amara.org',
  'Grazie per la visione',
  'Ondertiteld door de Amara.org gemeenschap',
  'Napisy stworzone przez społeczność Amara.org',
  'Субтитры сделал DimaTorzok',
  'Субтитры создавал DimaTorzok',
  'Продолжение следует',
  'Спасибо за просмотр',
  'ご視聴ありがとうございました',
  'チャンネル登録お願いします',
  '字幕由Amara.org社区提供',
  '谢谢观看',
  '感谢观看',
  '시청해 주셔서 감사합니다',
  'ИНТРИГУЮЩАЯ МУЗЫКА',
  'ВЕСЕЛАЯ МУЗЫКА',
  'СПОКОЙНАЯ МУЗЫКА',
  'ПЕЧАЛЬНАЯ МУЗЫКА',
];

/** Subtitle and transcription credits: any sentence starting like this ("Subtitles by …"). */
export const HALLUCINATION_PREFIXES = [
  'Subtitles by',
  'Subtitled by',
  'Captions by',
  'Transcription by',
  'Transcribed by',
  'Translated by',
  'Untertitel der',
  'Untertitel im Auftrag',
  'Sous-titres réalisés',
  'Sous-titrage',
  'Subtítulos realizados',
  'Subtítulos por',
  'Sottotitoli creati',
  'Legendas pela',
  'Napisy stworzone',
  'Ondertiteld door',
  'Редактор субтитров',
  'Субтитры сделал',
  'Субтитры создавал',
  'Субтитры подготовил',
  '字幕由',
];

/** Lower case, punctuation and symbols as spaces, single spaces. */
export function normalizePhrase(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim();
}

const PHRASES = new Set(HALLUCINATION_PHRASES.map(normalizePhrase));
const PREFIXES = HALLUCINATION_PREFIXES.map(normalizePhrase);
/** Filler words allowed before a known phrase ("So thank you for watching."). */
const FILLERS = new Set([
  'so',
  'and',
  'okay',
  'ok',
  'well',
  'oh',
  'yeah',
  'um',
  'uh',
  'all',
  'right',
  'alright',
]);

/** Whether a sentence is a known hallucination phrase or credit, perhaps after a filler word or two. */
export function isHallucinationPhrase(sentence: string): boolean {
  const words = normalizePhrase(sentence).split(' ').filter(Boolean);
  for (let skip = 0; skip <= 2 && skip < words.length; skip++) {
    if (skip > 0 && !FILLERS.has(words[skip - 1]!)) break;
    const rest = words.slice(skip).join(' ');
    if (PHRASES.has(rest) || PREFIXES.some((p) => rest === p || rest.startsWith(`${p} `))) return true;
  }
  return false;
}

/** openai/whisper's avg_logprob: the mean over the text tokens and the end token. */
export function averageLogprob(decode: ClipDecode): number {
  const sum = decode.tokens.reduce((n, t) => n + t.logprob, 0) + (decode.endLogprob ?? 0);
  return sum / (decode.tokens.length + 1);
}

/**
 * Where Whisper's repetition loop starts, or -1: the first place where some run of up to
 * `loopMaxPeriod` tokens repeats back to back at least three times, over `loopMinTokens` or more
 * tokens. Works on tokens, so it also catches loops in languages written without spaces. The
 * index is just after the first copy of the repeated run.
 */
export function loopStart(
  ids: readonly number[],
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): number {
  let start = -1;
  for (let period = 1; period <= limits.loopMaxPeriod && period * 3 <= ids.length; period++) {
    let run = 0;
    for (let i = period; i < ids.length && (start < 0 || i - run < start); i++) {
      run = ids[i] === ids[i - period] ? run + 1 : 0;
      if (run >= 2 * period && run >= limits.loopMinTokens) {
        const at = i - run + 1;
        if (start < 0 || at < start) start = at;
        break;
      }
    }
  }
  return start;
}

/** Whether Whisper fell into a repetition loop (see `loopStart`). */
export function hasLoop(ids: readonly number[], limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return loopStart(ids, limits) >= 0;
}

/** Splits the tokens into sentences (ending in . ! ? or their CJK forms), each with its tokens. */
export function sentences(tokens: readonly ScoredToken[]): ScoredToken[][] {
  const out: ScoredToken[][] = [];
  let current: ScoredToken[] = [];
  for (const token of tokens) {
    current.push(token);
    if (/[.!?。！？]["')\]]*\s*$/.test(token.text)) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Where a sentence of `loopSentenceTokens`+ tokens starts repeating, or -1: the start of its second
 * copy, for a sentence that occurs three or more times (not always back to back, so `loopStart`
 * misses it: "It was a good day. It was fine. It was a good day. …").
 */
export function repeatStart(
  tokens: readonly ScoredToken[],
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): number {
  const seen = new Map<string, number[]>();
  let at = 0;
  let start = -1;
  for (const sentence of sentences(tokens)) {
    if (sentence.length >= limits.loopSentenceTokens) {
      const key = sentence.map((t) => t.id).join(',');
      const starts = seen.get(key) ?? [];
      starts.push(at);
      seen.set(key, starts);
      if (starts.length === 3 && (start < 0 || starts[1]! < start)) start = starts[1]!;
    }
    at += sentence.length;
  }
  return start;
}

/** Where the decode starts looping (either kind), or -1. */
function loopAt(decode: ClipDecode, limits: HallucinationLimits): number {
  const starts = [
    loopStart(
      decode.tokens.map((t) => t.id),
      limits,
    ),
    repeatStart(decode.tokens, limits),
  ];
  const found = starts.filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
}

/** Whether the decode loops: a repeating token run or a sentence said three times. */
export function isLooping(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return loopAt(decode, limits) >= 0;
}

/** The decode cut where its loop starts (the "delooping" of Barański et al.); unchanged without one. */
export function deloop(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): ClipDecode {
  const at = loopAt(decode, limits);
  if (at < 0) return decode;
  const tokens = decode.tokens.slice(0, at);
  return { ...decode, tokens, endLogprob: null, text: decode.detokenize(tokens.map((t) => t.id)) };
}

const meanLogprob = (tokens: readonly ScoredToken[]) =>
  tokens.reduce((n, t) => n + t.logprob, 0) / Math.max(1, tokens.length);

/**
 * Removes known hallucination phrases ("Thank you for watching.", "Subtitles by …") from the end
 * of the clip's text (which may be all of it) unless Whisper was confident of them: a real
 * "Thank you." is decoded with high probability, one invented for silence or noise is not.
 * Whisper adds them where a clip trails off into silence; one followed by more speech is kept.
 */
export function stripHallucinationPhrases(
  decode: ClipDecode,
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): string {
  const parts = sentences(decode.tokens);
  const count = parts.length;
  const doubtful = (s: ScoredToken[]) =>
    meanLogprob(s) < limits.phraseLogprob && isHallucinationPhrase(decode.detokenize(s.map((t) => t.id)));
  while (parts.length && doubtful(parts[parts.length - 1]!)) parts.pop();
  if (parts.length === count) return decode.text;
  return parts.length ? decode.detokenize(parts.flat().map((t) => t.id)) : '';
}

export type DropReason = 'silence' | 'loop' | 'low-confidence' | 'phrase';

export interface ClipVerdict {
  text: string;
  /** Why Whisper's text was dropped (all of it, or the hallucinated phrases). */
  dropped?: DropReason;
  /** Whether the clip was decoded a second time. */
  retried: boolean;
}

/** Whisper says nobody is speaking and isn't sure of what it wrote. */
export function isSilent(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return decode.noSpeechProb > limits.noSpeech && averageLogprob(decode) < limits.noSpeechLogprob;
}

/** A decode worth a second try: a loop, cut off by the token limit, or low confidence. */
export function isDoubtful(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return (
    isLooping(decode, limits) || decode.endLogprob === null || averageLogprob(decode) < limits.retryLogprob
  );
}

/**
 * Transcribes a clip with hallucination checks. `decode(false)` is Whisper's usual greedy pass;
 * a doubtful result is decoded again with timestamps (`decode(true)`), which kept Whisper Tiny on
 * track in most of the loops and invented sentences we measured, and the better decode is used:
 * one without a loop if it is likely enough, else the text before the loop. Silence, text that
 * stays unlikely, and known hallucination phrases Whisper isn't sure of are dropped.
 */
export async function transcribeChecked(
  decode: (timestamps: boolean) => Promise<ClipDecode>,
  clipSeconds: number,
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): Promise<ClipVerdict> {
  const first = await decode(false);
  if (isSilent(first, limits)) return { text: '', dropped: 'silence', retried: false };
  let best = first;
  let retried = false;
  if (isDoubtful(first, limits)) {
    retried = true;
    const second = await decode(true);
    const voiced = [first, second].filter((d) => !isSilent(d, limits));
    const likely = (d: ClipDecode) => averageLogprob(d) >= limits.minLogprob;
    const better = (a: ClipDecode, b: ClipDecode) => (averageLogprob(b) > averageLogprob(a) ? b : a);
    const clean = voiced.filter((d) => !isLooping(d, limits) && likely(d));
    const cut = voiced.map((d) => deloop(d, limits)).filter((d) => d.tokens.length && likely(d));
    if (clean.length) best = clean.reduce(better);
    else if (cut.length) best = cut.reduce(better);
    else {
      const looped = voiced.some((d) => isLooping(d, limits));
      return {
        text: '',
        dropped: voiced.length === 0 ? 'silence' : looped ? 'loop' : 'low-confidence',
        retried,
      };
    }
  }
  const stripped = stripHallucinationPhrases(best, limits);
  const text = cleanTranscript(stripped, clipSeconds);
  return stripped === best.text ? { text, retried } : { text, dropped: 'phrase', retried };
}
