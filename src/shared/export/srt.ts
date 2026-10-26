import { formatSrtTimestamp } from '../time';
import { isRtlText, RLM, type ExportRow } from './common';

/**
 * Subtitle layout targets (common broadcast guidelines), in columns: a Chinese, Japanese or Korean
 * character takes two, as on screen.
 */
export const SRT_LIMITS = {
  charsPerLine: 42,
  maxLines: 2,
  /** Target maximum columns per cue (including the "Speaker: " prefix). */
  charsPerCue: 84,
  /** Target maximum cue duration. */
  maxCueMs: 7000,
  /** Cues shorter than this are lengthened when the next cue leaves room. */
  minCueMs: 500,
} as const;

interface Cue {
  startMs: number;
  endMs: number;
  /** Text without the speaker prefix. */
  text: string;
  speaker: string;
  rtl: boolean;
}

/** A stretch of text, [start, end) in its string, that is not broken further. */
interface Unit {
  start: number;
  end: number;
  width: number;
}

const CLOSERS = `"'”’»)）」』】〉》`;

/**
 * Where sentences end: after . ! ? … and a space, or after the stops of other scripts, which need
 * no space: Arabic ؟, Urdu ۔, Devanagari । ॥, Armenian ։, Ethiopic ።, Myanmar ။, Khmer ។ and
 * Chinese/Japanese 。！？. Closing quotes and brackets stay with their sentence.
 */
const SENTENCE_BREAK = new RegExp(
  `(?<=[.!?…][${CLOSERS}]*)\\s+|(?<=[؟۔।॥։።။។。！？][${CLOSERS}]*)(?![${CLOSERS}])\\s*`,
  'gu',
);

/** Scripts written without spaces between words: broken into words by the platform's dictionaries. */
const UNSPACED =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}]/u;

/** Opening brackets and quotes, which stay with the word after them ("「直」" is not cut after "「"). */
const OPENING = /^[\p{Ps}\p{Pi}]+$/u;

/** Characters two columns wide: Chinese, Japanese and Korean script, full-width forms, emoji. */
const WIDE =
  /(?![\uff61-\uffdc\uffe8-\uffee])[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6\p{Emoji_Presentation}]/gu;

/** Marks and format characters, drawn on or between other characters: no width of their own. */
const ZERO_WIDTH = /[\p{M}\p{Cf}]/gu;

let segmenters: { grapheme: Intl.Segmenter; word: Intl.Segmenter } | null | undefined;

/** Intl.Segmenter, where the platform has it (all current browsers and Node). */
function getSegmenters() {
  if (segmenters === undefined) {
    segmenters =
      typeof Intl.Segmenter === 'function'
        ? { grapheme: new Intl.Segmenter(), word: new Intl.Segmenter(undefined, { granularity: 'word' }) }
        : null;
  }
  return segmenters;
}

/** User-perceived characters: a Thai or Hindi letter with its marks, a surrogate pair, an emoji. */
function graphemes(text: string): string[] {
  const s = getSegmenters();
  return s ? Array.from(s.grapheme.segment(text), (g) => g.segment) : [...text];
}

/** Columns the text takes on screen: characters, not UTF-16 units; marks none, wide ones two. */
export function textWidth(text: string): number {
  // Latin, Greek and Cyrillic without combining marks: one column per code unit.
  if (!/[^\u0000-\u02ff\u0370-\u052f]/.test(text)) return text.length;
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  return text.length - count(/[\uD800-\uDBFF]/g) - count(ZERO_WIDTH) + count(WIDE);
}

/** Words of a piece of text without spaces, with punctuation attached to them, as [start, end). */
function wordRanges(text: string): [number, number][] {
  const s = getSegmenters();
  if (!s) {
    let at = 0;
    return [...text].map((c): [number, number] => [at, (at += c.length)]);
  }
  const out: [number, number][] = [];
  let open = -1;
  for (const { segment, index, isWordLike } of s.word.segment(text)) {
    if (!isWordLike && OPENING.test(segment)) {
      if (open < 0) open = index;
    } else if (!isWordLike && open < 0 && out.length) {
      // Closing punctuation ("。", "」") never starts a line.
      out[out.length - 1]![1] = index + segment.length;
    } else {
      out.push([open < 0 ? index : open, index + segment.length]);
      open = -1;
    }
  }
  if (open >= 0) out.push([open, text.length]);
  return out;
}

/** Where text may be broken: at spaces, and between the words of text written without them. */
function words(text: string): Unit[] {
  const out: Unit[] = [];
  const add = (start: number, end: number) =>
    out.push({ start, end, width: textWidth(text.slice(start, end)) });
  for (const m of text.matchAll(/\S+/g)) {
    if (UNSPACED.test(m[0])) for (const [s, e] of wordRanges(m[0])) add(m.index + s, m.index + e);
    else add(m.index, m.index + m[0].length);
  }
  return out;
}

/** The units, each one wider than `max` cut between its parts (a URL's) or else its characters. */
function fit(text: string, units: Unit[], max: number): Unit[] {
  const out: Unit[] = [];
  for (const u of units) {
    if (u.width <= max) {
      out.push(u);
      continue;
    }
    for (const [s, e] of wordRanges(text.slice(u.start, u.end))) {
      let piece: Unit = { start: u.start + s, end: u.start + s, width: 0 };
      // Between characters, never inside one: that would orphan a mark or half a surrogate pair.
      for (const g of graphemes(text.slice(u.start + s, u.start + e))) {
        const w = textWidth(g);
        if (piece.width + w > max && piece.end > piece.start) {
          out.push(piece);
          piece = { start: piece.end, end: piece.end, width: 0 };
        }
        piece.end += g.length;
        piece.width += w;
      }
      out.push(piece);
    }
  }
  return out;
}

/** Greedily packs units into pieces at most `max` wide; a space between units counts one column. */
function pack(items: Unit[], max: number): [number, number][] {
  const pieces: [number, number][] = [];
  let piece: [number, number] | null = null;
  let width = 0;
  for (const u of items) {
    const gap = piece && u.start > piece[1] ? 1 : 0;
    if (piece && width + gap + u.width <= max) {
      piece[1] = u.end;
      width += gap + u.width;
    } else {
      if (piece) pieces.push(piece);
      piece = [u.start, u.end];
      width = u.width;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * Splits text into pieces at most `max` columns wide, at spaces or between words (Chinese,
 * Japanese and Thai have no spaces), as [start, end) ranges: joined pieces read as the text did.
 */
function splitRanges(text: string, max: number, units = words(text)): [number, number][] {
  return pack(fit(text, units, max), max);
}

/** Breaks a row's text into cue-sized chunks at sentence boundaries where possible. */
function chunkText(text: string, maxWidth: number, maxChunks: number): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const sentences: Unit[] = [];
  const addSentence = (start: number, end: number) => {
    if (end <= start) return;
    const width = textWidth(flat.slice(start, end));
    if (width <= maxWidth) sentences.push({ start, end, width });
    else {
      for (const [s, e] of splitRanges(flat.slice(start, end), maxWidth)) {
        sentences.push({
          start: start + s,
          end: start + e,
          width: textWidth(flat.slice(start + s, start + e)),
        });
      }
    }
  };
  let at = 0;
  for (const m of flat.matchAll(SENTENCE_BREAK)) {
    addSentence(at, m.index);
    at = m.index + m[0].length;
  }
  addSentence(at, flat.length);

  // Greedily pack sentences into chunks up to maxWidth.
  let chunks = pack(sentences, maxWidth);

  // A short row can't hold many readable cues: re-pack into fewer, larger chunks.
  if (chunks.length > maxChunks) {
    chunks = splitRanges(flat, Math.ceil(textWidth(flat) / maxChunks));
    if (chunks.length > maxChunks) {
      chunks.splice(maxChunks - 1, Infinity, [chunks[maxChunks - 1]![0], flat.length]);
    }
  }
  return chunks.map(([s, e]) => flat.slice(s, e));
}

function rowToCues(row: ExportRow): Cue[] {
  const prefixWidth = textWidth(row.speakerName) + 2;
  const maxChars = Math.max(30, SRT_LIMITS.charsPerCue - prefixWidth);
  const text = row.text.trim();
  const rtl = isRtlText(text, row.lang);
  let span = row.endMs - row.startMs;
  if (span <= 0) {
    // Zero-length rows still need to be on screen long enough to read; the overlap pass trims this.
    span = Math.min(5000, Math.max(1000, text.length * 60));
  }
  const maxChunksByDuration = Math.max(1, Math.floor(span / SRT_LIMITS.minCueMs));
  const minChunksByDuration = Math.ceil(span / SRT_LIMITS.maxCueMs);
  let chunks = chunkText(text, maxChars, maxChunksByDuration);
  // Very long cues (in time) are split further when there is enough text to share.
  if (chunks.length < minChunksByDuration && chunks.length > 0) {
    const finer = chunkText(
      text,
      Math.max(20, Math.ceil(textWidth(text) / minChunksByDuration)),
      maxChunksByDuration,
    );
    if (finer.length > chunks.length) chunks = finer;
  }
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  const cues: Cue[] = [];
  let consumed = 0;
  chunks.forEach((chunk, i) => {
    const startMs = row.startMs + Math.round((span * consumed) / total);
    consumed += chunk.length;
    const endMs =
      i === chunks.length - 1 ? row.startMs + span : row.startMs + Math.round((span * consumed) / total);
    cues.push({ startMs, endMs, text: chunk, speaker: row.speakerName, rtl });
  });
  return cues;
}

/** Greedy word wrap; tries slightly wider lines when that avoids a third line. */
export function wrapCueText(text: string): string[] {
  const units = words(text);
  const wrap = (width: number) =>
    splitRanges(text, width, units).map(([s, e]) => text.slice(s, e).replace(/\s+/g, ' '));
  const standard = wrap(SRT_LIMITS.charsPerLine);
  if (standard.length <= SRT_LIMITS.maxLines) return standard;
  for (let width = SRT_LIMITS.charsPerLine + 1; width <= SRT_LIMITS.charsPerLine + 18; width++) {
    const lines = wrap(width);
    if (lines.length <= SRT_LIMITS.maxLines) return lines;
  }
  return standard;
}

/** Orders cues and removes overlaps; every cue ends after it starts. */
function resolveTiming(cues: Cue[]): Cue[] {
  const sorted = cues
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.startMs - b.c.startMs || a.i - b.i)
    .map(({ c }) => ({ ...c }));
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i]!;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    if (prev) cue.startMs = Math.max(cue.startMs, prev.endMs);
    if (next && cue.endMs > next.startMs) cue.endMs = next.startMs;
    if (cue.endMs - cue.startMs < SRT_LIMITS.minCueMs) {
      const room = next ? Math.max(next.startMs, cue.endMs) : Number.POSITIVE_INFINITY;
      cue.endMs = Math.min(cue.startMs + SRT_LIMITS.minCueMs, room);
    }
    // Overlapping speech can leave no room at all; keep the cue visible and push the next one back.
    if (cue.endMs <= cue.startMs) cue.endMs = cue.startMs + 1;
  }
  return sorted;
}

/**
 * SubRip subtitles. Each cue's first line is prefixed with "Speaker: ". Rows without text are
 * skipped. Lines of right-to-left rows start with a right-to-left mark: players lay out each line
 * by its first letter, which would otherwise be the speaker name's.
 */
export function toSrt(rows: ExportRow[]): string {
  const cues = resolveTiming(rows.filter((r) => r.text.trim() !== '').flatMap(rowToCues));
  const blocks = cues.map((cue, i) => {
    const lines = wrapCueText(`${cue.speaker}: ${cue.text}`).map((line) => (cue.rtl ? RLM + line : line));
    return `${i + 1}\r\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\r\n${lines.join('\r\n')}`;
  });
  return blocks.length ? `${blocks.join('\r\n\r\n')}\r\n` : '';
}
