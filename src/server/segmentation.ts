import { defaultSpeakerName, makeId } from '../shared/speakers';
import { joinText } from '../shared/text';
import type { Speaker, TranscriptRow } from '../shared/types';
import type { ProviderSegment } from './providers/types';

/** A provider segment, or the in-browser engine's, which also says what language it is in. */
type Segment = ProviderSegment & { lang?: string | null };

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Turns provider segments into speakers + rows. A new row starts every time the speaker (or the
 * segment's language) changes; consecutive segments from the same speaker are merged into a
 * single row, which carries their language when they have one.
 * Speakers are numbered in order of first appearance ("Speaker 1", "Speaker 2", …).
 * A segment without a speaker label continues the previous speaker.
 */
export function buildDocument(segments: Segment[]): { speakers: Speaker[]; rows: TranscriptRow[] } {
  const cleaned = segments
    .map((s, index) => ({ ...s, text: normalizeText(s.text ?? ''), index }))
    .filter((s) => s.text.length > 0)
    // Stable sort by start time; the original index breaks ties.
    .sort((a, b) => toMs(a.startMs) - toMs(b.startMs) || a.index - b.index);

  const speakers: Speaker[] = [];
  const byLabel = new Map<string, Speaker>();
  const rows: TranscriptRow[] = [];

  const speakerFor = (label: string): Speaker => {
    let speaker = byLabel.get(label);
    if (!speaker) {
      const n = speakers.length;
      speaker = { id: `spk_${n + 1}`, name: defaultSpeakerName(n), colorIndex: n };
      speakers.push(speaker);
      byLabel.set(label, speaker);
    }
    return speaker;
  };

  let previous: Speaker | null = null;
  for (const seg of cleaned) {
    const label = seg.speaker == null || seg.speaker === '' ? null : String(seg.speaker);
    const speaker: Speaker = label != null ? speakerFor(label) : (previous ?? speakerFor('__unlabelled__'));
    const startMs = toMs(seg.startMs);
    const endMs = Math.max(startMs, toMs(seg.endMs));
    const lang = seg.lang || undefined;
    const last = rows[rows.length - 1];
    if (last && last.speakerId === speaker.id && last.lang === lang) {
      // No space between pieces of Chinese or Japanese (provider words come one by one).
      last.text = joinText(last.text, seg.text);
      last.endMs = Math.max(last.endMs, endMs);
    } else {
      const row: TranscriptRow = { id: makeId('row'), speakerId: speaker.id, startMs, endMs, text: seg.text };
      if (lang) row.lang = lang;
      rows.push(row);
    }
    previous = speaker;
  }

  return { speakers, rows };
}
