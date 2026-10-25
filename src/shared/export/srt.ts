import { formatSrtTimestamp } from '../time';
import type { ExportRow } from './common';

/** Subtitle layout targets (common broadcast guidelines). */
export const SRT_LIMITS = {
  charsPerLine: 42,
  maxLines: 2,
  /** Target maximum characters per cue (including the "Speaker: " prefix). */
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
}

const SENTENCE_BREAK = /(?<=[.!?…])\s+|(?<=[。！？])/u;

/** Splits text into pieces of at most `max` characters, preferring word boundaries. */
function splitByLength(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  let current = '';
  const pushHard = (word: string) => {
    // A single "word" longer than the limit (or text without spaces, e.g. CJK) is cut hard.
    for (let i = 0; i < word.length; i += max) pieces.push(word.slice(i, i + max));
  };
  for (const word of words) {
    if (word.length > max) {
      if (current) pieces.push(current);
      current = '';
      pushHard(word);
      // Keep the last hard-cut fragment open so following words can join it.
      current = pieces.pop() ?? '';
      continue;
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= max) current += ` ${word}`;
    else {
      pieces.push(current);
      current = word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Breaks a row's text into cue-sized chunks at sentence boundaries where possible. */
function chunkText(text: string, maxChars: number, maxChunks: number): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const pieces = flat
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => (s.length > maxChars ? splitByLength(s, maxChars) : [s]));

  // Greedily pack sentences into chunks up to maxChars.
  let chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last != null && last.length + 1 + piece.length <= maxChars)
      chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }

  // A short row can't hold many readable cues: re-pack into fewer, larger chunks.
  if (chunks.length > maxChunks) {
    const target = Math.ceil(flat.length / maxChunks);
    const repacked: string[] = [];
    for (const piece of splitByLength(flat, target)) {
      const last = repacked[repacked.length - 1];
      if (last != null && repacked.length >= maxChunks) repacked[repacked.length - 1] = `${last} ${piece}`;
      else repacked.push(piece);
    }
    chunks = repacked;
  }
  return chunks;
}

function rowToCues(row: ExportRow): Cue[] {
  const prefixLength = row.speakerName.length + 2;
  const maxChars = Math.max(30, SRT_LIMITS.charsPerCue - prefixLength);
  const text = row.text.trim();
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
      Math.max(20, Math.ceil(text.length / minChunksByDuration)),
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
    cues.push({ startMs, endMs, text: chunk, speaker: row.speakerName });
  });
  return cues;
}

/** Greedy word wrap; tries slightly wider lines when that avoids a third line. */
export function wrapCueText(text: string): string[] {
  const wrap = (width: number) => {
    const lines: string[] = [];
    for (const piece of splitByLength(text, width)) lines.push(piece);
    return lines;
  };
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

/** SubRip subtitles. Each cue's first line is prefixed with "Speaker: ". Rows without text are skipped. */
export function toSrt(rows: ExportRow[]): string {
  const cues = resolveTiming(rows.filter((r) => r.text.trim() !== '').flatMap(rowToCues));
  const blocks = cues.map((cue, i) => {
    const lines = wrapCueText(`${cue.speaker}: ${cue.text}`);
    return `${i + 1}\r\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\r\n${lines.join('\r\n')}`;
  });
  return blocks.length ? `${blocks.join('\r\n\r\n')}\r\n` : '';
}
