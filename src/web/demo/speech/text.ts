// Clean-up of Whisper's text for one clip, and the checks that keep Whisper's hallucinations
// (text invented for noise, silence or unclear audio) out of the transcript.
import { joinTexts } from '../../../shared/text';

/**
 * Whisper's usual output for non-speech: sound tags ("[Music]", "【音楽】", "(laughs)", "（拍手）",
 * "♪", "♪～") and nothing else. Brackets and notes always go; parentheses also hold real speech
 * ("2020年(令和2年)"), so those go only when `isSoundTag` says so. (Brackets Whisper never closes
 * and captions in capitals: see `withoutCaptions`.)
 */
const SOUND_TAGS = /\[[^\]]*\]|［[^］]*］|【[^】]*】|[~～〜]*[♪♫♬]+[~～〜]*|\([^)]*\)|（[^）]*）/g;

/**
 * Stems of the words of the sound tags Whisper writes, in Latin and Cyrillic letters, in the
 * languages it writes them most; each starts a word ("(Risas)", not "(Larisa)").
 */
const SOUND_STEMS = [
  'laugh|chuckl|giggl|applau|music|cheer|clap|cough|sigh|sniff|gasp|groan|scream|whisper',
  'mumbl|inaudible|indistinct|unintelligible|crosstalk|silence|noise|static|beep|breath|sobs|crying',
  'risa|aplauso|música|rire|applaudissement|musique|lach|musik|risate|applausi|musica|risos',
  'смех|аплодисмент|музык|śmiech|oklaski|muzyk|gelach|muziek|kahkaha|alkış|müzik',
].join('|');
/** The same words in scripts without case. */
const SOUND_SIGNS =
  '笑|拍手|音楽|音乐|掌声|歓声|웃음|박수|음악|ضحك|تصفيق|موسيق|צחוק|מחיאות|מוזיקה|हँसी|तालियाँ|संगीत';

/** Text with a word of a sound tag in it (no lookbehind: older Safari). */
const SOUND_WORDS = new RegExp(`(?:^|\\P{L})(?:${SOUND_STEMS})|${SOUND_SIGNS}`, 'iu');
/**
 * A whole word of a sound tag: a stem with an ending its tags give it ("Music", "Laughter",
 * "Applause", "Музыка"), not a longer word ("Musicians", "Musical"); or signs only ("音楽").
 */
const SOUND_WORD = new RegExp(
  `^(?:(?:${SOUND_STEMS})(?:e?s|e|se|ing|ter|en|a|а|ы)?|(?:${SOUND_SIGNS})+)$`,
  'iu',
);

/**
 * The captions of subtitles for the deaf that Whisper writes in capitals for music and noise: the
 * ones it wrote in our tests, as whole phrases. Other words in capitals are speech ("NASA, NATO.",
 * "ООН КРИК О ПОМОЩИ", "BBC MUSIC.").
 */
const CAPTION_PHRASES = [
  '[А-ЯЁ]+[АЯ]Я МУЗЫКА', // ДИНАМИЧНАЯ, ВЕСЕЛАЯ, ИНТРИГУЮЩАЯ, ТРЕВОЖНАЯ, СПОКОЙНАЯ …
  'МУЗЫКА',
  'МУЗЫКАЛЬНАЯ ЗАСТАВКА',
  'СМЕХ',
  'АПЛОДИСМЕНТЫ',
  'СТУК(?: В ДВЕРЬ)?',
  'ВЫСТРЕЛЫ?',
  '(?:(?:OUTRO|INTRO) )?MUSIC(?: PLAYING)?',
].join('|');
/** Caption phrases and nothing else. */
const CAPTION = new RegExp(`^(?:${CAPTION_PHRASES})(?: (?:${CAPTION_PHRASES}))*$`, 'u');
/** A caption phrase starting the text, as whole words. */
const CAPTION_START = new RegExp(`^(?:${CAPTION_PHRASES})(?![\\p{L}\\p{N}])`, 'u');

/**
 * Whether a sentence of Whisper's text is a caption: caption phrases only (`CAPTION_PHRASES`), with
 * punctuation, brackets or music notes. Digits are speech ("1, 2, 3 ДИНАМИЧНАЯ МУЗЫКА" stays).
 */
function isCaption(sentence: string): boolean {
  return CAPTION.test(sentence.replace(/[\p{P}\p{S}\s]+/gu, ' ').trim());
}

/**
 * `rest`, the text after a bracket Whisper opened and never closed, without its first word if that
 * belongs to the tag, else null: notes or punctuation, a caption phrase ("OUTRO MUSIC PLAYING"), a
 * whole sound word ("Music", "音楽"), or a single capital where the text ends ("[♪ O", cut off).
 */
function afterTagWord(rest: string, textEnds: boolean): string | null {
  const start = rest.trimStart();
  const phrase = CAPTION_START.exec(start);
  if (phrase) return start.slice(phrase[0].length);
  const word = /^\S+/.exec(start)?.[0];
  if (!word) return null;
  const after = start.slice(word.length);
  const core = word.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
  const cutOff = textEnds && !after.trim() && /^\p{Lu}$/u.test(core);
  return !core || SOUND_WORD.test(core) || cutOff ? after : null;
}

/**
 * The text without the brackets Whisper opened and never closed, each with the tag right after it
 * (see `afterTagWord`: "[♪ OUTRO MUSIC PLAYING [♪" goes, the speech after "[Music" stays, and so
 * do other words in capitals: "[Music USA! USA!"), and without stray closing brackets.
 */
function withoutUnclosedBrackets(text: string): string {
  return text.replace(/[[［【]([^[［【\]］】]*)|[\]］】]/g, (tag, after: string | undefined, at: number) => {
    let rest = after ?? '';
    const textEnds = at + tag.length === text.length;
    for (let next = afterTagWord(rest, textEnds); next !== null; next = afterTagWord(rest, textEnds)) {
      rest = next;
    }
    return rest;
  });
}

/** A sentence (to . ! ? or their CJK forms) and the space after it. */
const SENTENCE = /[^.!?。！？]*[.!?。！？]+\s*|[^.!?。！？]+$/g;

/**
 * The text without the captions of subtitles for the deaf that Whisper writes for music and noise:
 * sentences that are only caption phrases ("ДИНАМИЧНАЯ МУЗЫКА", "СТУК В ДВЕРЬ"; see `isCaption`)
 * and the brackets it never closed, with the tag after them ("[♪ OUTRO MUSIC PLAYING [♪"; see
 * `withoutUnclosedBrackets`). Single-spaced if anything went.
 */
export function withoutCaptions(text: string): string {
  const parts = withoutUnclosedBrackets(text).match(SENTENCE) ?? [];
  const kept = parts.filter((s) => !isCaption(s)).join('');
  return kept === text ? text : kept.replace(/\s+/g, ' ').trim();
}

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

/** The text without its sound tags, single-spaced. */
function withoutSoundTags(text: string): string {
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
  return joinTexts(pieces).replace(/\s+/g, ' ').trim();
}

/** Cleans Whisper's text for a clip: drops sound tags, lone "you" hallucinations and loops. */
export function cleanTranscript(text: string, clipSeconds: number): string {
  let out = withoutSoundTags(text);
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

const idsOf = (tokens: readonly ScoredToken[]) => tokens.map((t) => t.id);

/** One Whisper decode of a clip, with the evidence used to judge it. */
export interface ClipDecode {
  /** Whisper's text as returned by Transformers.js. */
  text: string;
  /** The text tokens in order (no special or timestamp tokens). */
  tokens: ScoredToken[];
  /**
   * Log-probability of the end-of-text token, or null when the text was cut off before it: by the
   * token limit, at a repetition loop (see `loopGuard`), or by `deloop`.
   */
  endLogprob: number | null;
  /** Whether the token limit cut the text off (not a loop, and not Whisper ending it). */
  truncated: boolean;
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
  /**
   * Whisper is steered out of a loop (see `loopGuard`) only if its text so far averages at least
   * this, and the text it writes after the loop is kept only if that does too: around a chant
   * Tiny scored ≥ -0.18, around the loops it fell into on meetings and noise ≤ -0.54.
   */
  loopSpeechLogprob: -0.5,
} as const;

export type HallucinationLimits = { [K in keyof typeof HALLUCINATION_LIMITS]: number };

/** Whisper's whole budget of new tokens: its 448 positions less the prompt. */
export const WHISPER_MAX_NEW_TOKENS = 444;

/**
 * Whisper languages written in Latin, Cyrillic or Greek letters, Han, kana or Hangul, which its
 * tokenizer writes in few tokens: at most 6.8 tokens per second of FLEURS speech, 5.1 in our TTS
 * tests. Other scripts take 1–2.7 tokens per character (Hindi read speech 8.6–20 tokens/s;
 * Bengali, Telugu, Malayalam and Burmese twice as many per character).
 */
const COMPACT_LANGUAGES = new Set(
  (
    'af az ba be bg br bs ca cs cy da de el en es et eu fi fo fr gl ha haw hr ht hu id is it ja jw ' +
    'kk ko la lb ln lt lv mg mi mk mn ms mt nl nn no oc pl pt ro ru sk sl sn so sq sr su sv sw tg tk ' +
    'tl tr tt uk uz vi yo yue zh'
  ).split(' '),
);

/**
 * Most tokens Whisper may write for a clip in `language` (a Whisper code) before the decode counts
 * as cut off: about three times the fastest speech we measured in compact scripts (see
 * `COMPACT_LANGUAGES`), so a loop the loop checks miss still stops long before Whisper's 448-token
 * limit (on Tiny, ~20 s for one 13 s clip), and 48 tokens a second, up to 440, in other scripts. A
 * decode the limit cuts off is decoded again with Whisper's whole budget (`transcribeChecked`).
 */
export function maxClipTokens(seconds: number, language: string): number {
  const perSecond = COMPACT_LANGUAGES.has(language) ? 16 : 48;
  return Math.min(440, 20 + Math.ceil(perSecond * seconds));
}

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
  '시청해주셔서 감사합니다',
  'شكرا للمشاهدة',
  'شكراً للمشاهدة',
  'ИНТРИГУЮЩАЯ МУЗЫКА',
  'ВЕСЕЛАЯ МУЗЫКА',
  'СПОКОЙНАЯ МУЗЫКА',
  'ПЕЧАЛЬНАЯ МУЗЫКА',
];

/**
 * The subscribe-and-like outros of videos that Whisper writes for music, compared like
 * `HALLUCINATION_PHRASES`: whole sentences only, as parts of them are often said ("구독 좋아요",
 * "请订阅").
 */
export const HALLUCINATION_OUTROS = [
  '구독과 좋아요 부탁드립니다',
  '구독 좋아요 부탁드립니다',
  '구독 부탁드립니다',
  'チャンネル登録よろしくお願いします',
  'ご視聴頂きありがとうございました',
  '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目',
  '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目',
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
const OUTROS = new Set(HALLUCINATION_OUTROS.map(normalizePhrase));
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

/**
 * Whether a sentence is a known hallucination phrase or credit (or, with `outros`, one of
 * `HALLUCINATION_OUTROS`), perhaps after a filler word or two. "You" counts only alone: "And you?"
 * is a real question.
 */
export function isHallucinationPhrase(sentence: string, outros = true): boolean {
  const words = normalizePhrase(sentence).split(' ').filter(Boolean);
  for (let skip = 0; skip <= 2 && skip < words.length; skip++) {
    if (skip > 0 && !FILLERS.has(words[skip - 1]!)) break;
    const rest = words.slice(skip).join(' ');
    if (skip > 0 && rest === 'you') break;
    if (PHRASES.has(rest) || (outros && OUTROS.has(rest))) return true;
    if (PREFIXES.some((p) => rest === p || rest.startsWith(`${p} `))) return true;
  }
  return false;
}

/** openai/whisper's avg_logprob: the mean over the text tokens and the end token. */
export function averageLogprob(decode: ClipDecode): number {
  const sum = decode.tokens.reduce((n, t) => n + t.logprob, 0) + (decode.endLogprob ?? 0);
  return sum / (decode.tokens.length + 1);
}

/** A repetition loop in a token sequence (see `loopStart`). */
interface TokenLoop {
  /** Just after the first copy of the repeated run. */
  at: number;
  /** Tokens in one copy of the repeated run. */
  period: number;
  /** How many tokens after the first copy repeat it (whole copies and perhaps part of one). */
  length: number;
}

/** The earliest repetition loop in `ids` (see `loopStart`), or null. */
function firstLoop(ids: readonly number[], limits: HallucinationLimits): TokenLoop | null {
  let found: TokenLoop | null = null;
  for (let period = 1; period <= limits.loopMaxPeriod && period * 3 <= ids.length; period++) {
    let run = 0;
    for (let i = period; i < ids.length && (!found || i - run < found.at); i++) {
      run = ids[i] === ids[i - period] ? run + 1 : 0;
      if (run >= 2 * period && run >= limits.loopMinTokens) {
        const at = i - run + 1;
        let end = i + 1;
        while (end < ids.length && ids[end] === ids[end - period]) end++;
        if (!found || at < found.at) found = { at, period, length: end - at };
        break;
      }
    }
  }
  return found;
}

/**
 * Where Whisper's repetition loop starts, or -1: the first place where some run of up to
 * `loopMaxPeriod` tokens repeats back to back at least three times, the copies after the first
 * covering `loopMinTokens` or more tokens. Works on tokens, so it also catches loops in languages
 * written without spaces. The index is just after the first copy of the repeated run.
 */
export function loopStart(
  ids: readonly number[],
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): number {
  return firstLoop(ids, limits)?.at ?? -1;
}

/** Whether Whisper fell into a repetition loop (see `loopStart`). */
export function hasLoop(ids: readonly number[], limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return loopStart(ids, limits) >= 0;
}

/** The periods of the repetition loops (see `loopStart`) that end at the last token. */
function trailingLoops(ids: readonly number[], limits: HallucinationLimits): TokenLoop[] {
  const out: TokenLoop[] = [];
  for (let period = 1; period <= limits.loopMaxPeriod && period * 3 <= ids.length; period++) {
    let run = 0;
    while (run < ids.length - period && ids[ids.length - 1 - run] === ids[ids.length - 1 - run - period])
      run++;
    if (run >= 2 * period && run >= limits.loopMinTokens)
      out.push({ at: ids.length - run, period, length: run });
  }
  return out;
}

/** What `loopGuard` says to do at a decoding step: nothing, ban these tokens, or end the text. */
export type LoopAction = null | { ban: number[] } | 'end';

/**
 * Steers a decode out of repetition loops as they happen; called at every step with the text
 * tokens so far. The first time the text ends in a loop (see `loopStart`), only the tokens that
 * would continue it are banned, as a no-repeat n-gram rule does, so Whisper moves on to what was
 * said next: people repeat themselves too (a chant, counting, "No, no, no, …"). The text is ended
 * there instead if Whisper was unsure of it (`loopSpeechLogprob`: the loops it falls into on noise
 * and unclear speech), if the loop already fills half of `budget` (the decode's token limit), or
 * if it loops again after the ban.
 */
export function loopGuard(
  budget: number,
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): (tokens: readonly Pick<ScoredToken, 'id' | 'logprob'>[]) => LoopAction {
  let bannedAt = -1;
  let banned: number[] = [];
  return (tokens) => {
    // Still waiting for a text token after the ban (a timestamp came first).
    if (bannedAt === tokens.length) return { ban: banned };
    const ids = tokens.map((t) => t.id);
    const loops = trailingLoops(ids, limits);
    if (!loops.length) return null;
    const unsure = meanLogprob(tokens) < limits.loopSpeechLogprob;
    if (bannedAt >= 0 || unsure || loops.some((l) => 2 * (l.period + l.length) >= budget)) return 'end';
    bannedAt = ids.length;
    banned = [...new Set(loops.map((l) => ids[ids.length - l.period]!))];
    return { ban: banned };
  };
}

/** Letters and digits that continue a word written in Latin, Cyrillic or Greek. */
const WORD_GOES_ON = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;

/**
 * Splits the tokens into sentences (ending in . ! ? or their CJK forms), each with its tokens. An
 * ASCII mark inside a word ("Amara.org", "А.Синецкая", "3.5") ends none: Whisper's tokenizer
 * writes it as a token of its own, and the rest of the word follows with no space.
 */
export function sentences(tokens: readonly ScoredToken[]): ScoredToken[][] {
  const out: ScoredToken[][] = [];
  let current: ScoredToken[] = [];
  for (const [i, token] of tokens.entries()) {
    current.push(token);
    if (!/[.!?。！？]["')\]]*\s*$/.test(token.text)) continue;
    const next = tokens[i + 1];
    if (next && /[.!?]$/.test(token.text) && WORD_GOES_ON.test(next.text)) continue;
    out.push(current);
    current = [];
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Where a sentence of `loopSentenceTokens`+ tokens starts repeating, or -1: the start of its second
 * copy, for a sentence that occurs three or more times (not always back to back, so `loopStart`
 * misses it: "It was a good day. It was fine. It was a good day. …"). People say a sentence three
 * times too ("Are you there? … Are you there?"), so it counts only if Whisper never got out of it
 * (every sentence from the second copy on repeats an earlier one) or the text was `cutOff`.
 */
export function repeatStart(
  tokens: readonly ScoredToken[],
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
  cutOff = false,
): number {
  // Where each sentence starts, by its tokens.
  const seen = new Map<string, { length: number; starts: number[] }>();
  let at = 0;
  // Every sentence from this token on repeats an earlier one.
  let repeatsFrom = 0;
  for (const sentence of sentences(tokens)) {
    const key = idsOf(sentence).join(',');
    const said = seen.get(key) ?? { length: sentence.length, starts: [] };
    if (!said.starts.length) repeatsFrom = at + sentence.length;
    said.starts.push(at);
    seen.set(key, said);
    at += sentence.length;
  }
  let start = -1;
  for (const { length, starts } of seen.values()) {
    if (length < limits.loopSentenceTokens || starts.length < 3) continue;
    const second = starts[1]!;
    if ((cutOff || second >= repeatsFrom) && (start < 0 || second < start)) start = second;
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
    repeatStart(decode.tokens, limits, decode.endLogprob === null),
  ];
  const found = starts.filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
}

/** Whether the decode loops: a repeating token run or a sentence said three times. */
export function isLooping(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return loopAt(decode, limits) >= 0;
}

/**
 * The decode with its loops taken out (the "delooping" of Barański et al.); unchanged without one.
 * If Whisper ended the text itself, it got out of its loops (see `loopGuard`): each run repeating
 * back to back keeps one copy, and the text after it is kept if it is speech Whisper was sure of
 * (`loopSpeechLogprob`). Otherwise, and in a text that was cut off, the text is cut where the loop
 * starts, after its first copy. From the second copy of a sentence said three times (see
 * `repeatStart`) the text is cut.
 */
export function deloop(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): ClipDecode {
  let tokens = decode.tokens;
  let cut = false;
  for (let loop = firstLoop(idsOf(tokens), limits); loop && !cut; loop = firstLoop(idsOf(tokens), limits)) {
    const after = tokens.slice(loop.at + loop.length);
    cut =
      decode.endLogprob === null ||
      !/[\p{L}\p{N}]/u.test(decode.detokenize(idsOf(after))) ||
      meanLogprob(after) < limits.loopSpeechLogprob;
    // Whole copies only: what is left is the same text, repeated fewer times (a copy can start or
    // end inside a character that takes several tokens).
    const copies = loop.length - (loop.length % loop.period);
    tokens = cut
      ? tokens.slice(0, loop.at)
      : [...tokens.slice(0, loop.at), ...tokens.slice(loop.at + copies)];
  }
  const at = repeatStart(tokens, limits, decode.endLogprob === null || cut);
  if (at >= 0) tokens = tokens.slice(0, at);
  if (tokens.length === decode.tokens.length) return decode;
  return {
    ...decode,
    tokens,
    endLogprob: cut || at >= 0 ? null : decode.endLogprob,
    text: decode.detokenize(idsOf(tokens)),
  };
}

function meanLogprob(tokens: readonly Pick<ScoredToken, 'logprob'>[]): number {
  return tokens.reduce((n, t) => n + t.logprob, 0) / Math.max(1, tokens.length);
}

/**
 * Removes known hallucination phrases ("Thank you for watching.", "Subtitles by …") from the end
 * of the clip's text (which may be all of it) unless Whisper was confident of them: a real
 * "Thank you." is decoded with high probability, one invented for silence or noise is not.
 * Whisper adds them where a clip trails off into silence; one followed by more speech is kept (a
 * sound tag such as "[Music]" or "♪", or a caption such as "ДИНАМИЧНАЯ МУЗЫКА", is not speech).
 * Without `outros`, the outros (`HALLUCINATION_OUTROS`) and captions (`withoutCaptions`) count as
 * speech, as where a split clip's halves are weighed (`ClipVerdict.withCaptions`).
 */
export function stripHallucinationPhrases(
  decode: ClipDecode,
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
  outros = true,
): string {
  const parts = sentences(decode.tokens);
  const text = (s: readonly ScoredToken[]) => decode.detokenize(idsOf(s));
  const doubtful = (s: readonly ScoredToken[]) =>
    meanLogprob(s) < limits.phraseLogprob && isHallucinationPhrase(text(s), outros);
  const speech = (t: string) => (outros ? withoutCaptions(withoutSoundTags(t)) : withoutSoundTags(t));
  const tagOnly = (s: readonly ScoredToken[]) => normalizePhrase(speech(text(s))) === '';
  let keep = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (doubtful(parts[i]!)) keep = i;
    else if (!tagOnly(parts[i]!)) break;
  }
  if (keep === parts.length) return decode.text;
  return keep ? text(parts.slice(0, keep).flat()) : '';
}

export type DropReason = 'silence' | 'loop' | 'low-confidence' | 'phrase';

export interface ClipVerdict {
  text: string;
  /**
   * The text with Whisper's captions and outros still in (see `withoutCaptions`,
   * `HALLUCINATION_OUTROS`): what a split clip's halves are weighed by, as they may be all that a
   * half of music gives.
   */
  withCaptions: string;
  /** Why Whisper's text was dropped (all of it, or the hallucinated phrases). */
  dropped?: DropReason;
  /** Whether the clip was decoded more than once. */
  retried: boolean;
  /**
   * Whether the text is only the start of what Whisper heard: the kept decode was cut off (at a
   * loop Whisper didn't get out of, or by the token limit) and the text before the cut used.
   */
  partial: boolean;
}

/** Whisper says nobody is speaking and isn't sure of what it wrote. */
export function isSilent(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return decode.noSpeechProb > limits.noSpeech && averageLogprob(decode) < limits.noSpeechLogprob;
}

/** A decode worth a second try: a loop, cut off, or low confidence. */
export function isDoubtful(decode: ClipDecode, limits: HallucinationLimits = HALLUCINATION_LIMITS): boolean {
  return (
    isLooping(decode, limits) || decode.endLogprob === null || averageLogprob(decode) < limits.retryLogprob
  );
}

/** Cut off by the token limit while Whisper was still writing, not looping. */
const cutShort = (decode: ClipDecode, limits: HallucinationLimits) =>
  decode.truncated && !isLooping(decode, limits);

/** The decode without the character its last tokens leave unfinished (a cut can split one). */
function withoutBrokenCharacter(decode: ClipDecode): ClipDecode {
  let { tokens, text } = decode;
  while (tokens.length && text.trimEnd().endsWith('�')) {
    tokens = tokens.slice(0, -1);
    text = decode.detokenize(idsOf(tokens));
  }
  return text === decode.text ? decode : { ...decode, tokens, text };
}

/**
 * Transcribes a clip with hallucination checks. `decode(false, false)` is Whisper's usual greedy
 * pass within the clip's token limit (`maxClipTokens`); a text that limit cut off while Whisper was
 * still writing is decoded again with Whisper's whole budget (`decode(false, true)`). A doubtful
 * result is decoded again with timestamps (`decode(true, …)`), which kept Whisper Tiny on track in
 * most of the loops and invented sentences we measured, and the better decode is used: one without
 * a loop if it is likely enough, else the decode with its loops taken out (`deloop`). Silence, text
 * that stays unlikely, and known hallucination phrases Whisper isn't sure of are dropped, and so
 * are its captions (`withoutCaptions`).
 */
export async function transcribeChecked(
  decode: (timestamps: boolean, wholeBudget: boolean) => Promise<ClipDecode>,
  clipSeconds: number,
  limits: HallucinationLimits = HALLUCINATION_LIMITS,
): Promise<ClipVerdict> {
  let first = await decode(false, false);
  if (isSilent(first, limits)) {
    return { text: '', withCaptions: '', dropped: 'silence', retried: false, partial: false };
  }
  let retried = false;
  // Fast speech, or a script the tokenizer spends several tokens per character on. (Not a retry
  // with timestamps: they take from the same budget.)
  const whole = cutShort(first, limits);
  if (whole) {
    retried = true;
    first = await decode(false, true);
  }
  let best = first;
  if (isDoubtful(first, limits)) {
    retried = true;
    let second = await decode(true, whole);
    if (!whole && cutShort(second, limits)) second = await decode(true, true);
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
        withCaptions: '',
        dropped: voiced.length === 0 ? 'silence' : looped ? 'loop' : 'low-confidence',
        retried,
        partial: false,
      };
    }
  }
  best = withoutBrokenCharacter(best);
  const partial = best.endLogprob === null;
  const stripped = stripHallucinationPhrases(best, limits);
  const text = withoutCaptions(cleanTranscript(stripped, clipSeconds));
  const withCaptions = cleanTranscript(stripHallucinationPhrases(best, limits, false), clipSeconds);
  return stripped === best.text
    ? { text, withCaptions, retried, partial }
    : { text, withCaptions, dropped: 'phrase', retried, partial };
}
