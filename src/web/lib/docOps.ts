// Pure editing operations on a transcript document. Every operation returns the SAME object when
// nothing changes, so the undo history can skip no-ops and memoised rows keep their identity.
import { DOCUMENT_LIMITS } from '../../shared/document';
import { defaultSpeakerName, makeId } from '../../shared/speakers';
import type { Speaker, TranscriptRow } from '../../shared/types';

/** The editable content of a transcript. The server version is tracked by the autosave, not here. */
export interface EditableDoc {
  speakers: Speaker[];
  rows: TranscriptRow[];
}

export const MAX_SPEAKER_NAME_LENGTH = DOCUMENT_LIMITS.maxSpeakerNameLength;

/** Collapses whitespace and trims; the result may be empty (callers reject empty names). */
export function normalizeSpeakerName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEAKER_NAME_LENGTH);
}

/** Colour for a speaker added now: one past the highest index in use, so it differs from all current ones. */
export function nextColorIndex(speakers: readonly Speaker[]): number {
  let max = -1;
  for (const s of speakers) max = Math.max(max, s.colorIndex);
  return max + 1;
}

/** First "Speaker N" name (N > current speaker count) that no existing speaker uses. */
export function nextSpeakerName(speakers: readonly Speaker[]): string {
  const taken = new Set(speakers.map((s) => s.name.toLocaleLowerCase()));
  let index = speakers.length;
  while (taken.has(defaultSpeakerName(index).toLocaleLowerCase())) index++;
  return defaultSpeakerName(index);
}

export function countRowsBySpeaker(rows: readonly TranscriptRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.speakerId, (counts.get(r.speakerId) ?? 0) + 1);
  return counts;
}

/** Removes speakers that no row references. */
export function pruneUnusedSpeakers<D extends EditableDoc>(doc: D): D {
  const used = new Set(doc.rows.map((r) => r.speakerId));
  if (doc.speakers.every((s) => used.has(s.id))) return doc;
  return { ...doc, speakers: doc.speakers.filter((s) => used.has(s.id)) };
}

/** Renames a speaker; every row of that speaker shows the new name because rows reference the id. */
export function renameSpeaker(doc: EditableDoc, speakerId: string, name: string): EditableDoc {
  const clean = normalizeSpeakerName(name);
  if (!clean) return doc;
  const index = doc.speakers.findIndex((s) => s.id === speakerId);
  const current = doc.speakers[index];
  if (!current || current.name === clean) return doc;
  const speakers = doc.speakers.slice();
  speakers[index] = { ...current, name: clean };
  return { ...doc, speakers };
}

function replaceRow(doc: EditableDoc, index: number, row: TranscriptRow): EditableDoc {
  const rows = doc.rows.slice();
  rows[index] = row;
  return { ...doc, rows };
}

/** Moves one row to another existing speaker; a speaker left without rows is pruned. */
export function reassignRow(doc: EditableDoc, rowId: string, speakerId: string): EditableDoc {
  const index = doc.rows.findIndex((r) => r.id === rowId);
  const row = doc.rows[index];
  if (!row || row.speakerId === speakerId || !doc.speakers.some((s) => s.id === speakerId)) return doc;
  return pruneUnusedSpeakers(replaceRow(doc, index, { ...row, speakerId }));
}

/**
 * Moves one row to a newly created speaker (name defaults to the next "Speaker N"; colour is
 * max(colorIndex)+1). `speakerId` is injectable for deterministic tests.
 */
export function reassignRowToNewSpeaker(
  doc: EditableDoc,
  rowId: string,
  name?: string,
  speakerId: string = makeId('spk'),
): EditableDoc {
  const index = doc.rows.findIndex((r) => r.id === rowId);
  const row = doc.rows[index];
  if (!row) return doc;
  const speaker: Speaker = {
    id: speakerId,
    name: normalizeSpeakerName(name ?? '') || nextSpeakerName(doc.speakers),
    colorIndex: nextColorIndex(doc.speakers),
  };
  const withSpeaker = { ...doc, speakers: [...doc.speakers, speaker] };
  return pruneUnusedSpeakers(replaceRow(withSpeaker, index, { ...row, speakerId: speaker.id }));
}

/** Replaces a row's text (leading/trailing whitespace trimmed; inner line breaks kept). */
export function editRowText(doc: EditableDoc, rowId: string, text: string): EditableDoc {
  const index = doc.rows.findIndex((r) => r.id === rowId);
  const row = doc.rows[index];
  const clean = text.trim();
  if (!row || row.text === clean) return doc;
  return replaceRow(doc, index, { ...row, text: clean });
}

function joinText(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(' ');
}

/** Merges rows[index] and rows[index + 1] into the upper row (its id and speaker are kept). */
function mergeAt(doc: EditableDoc, index: number): EditableDoc {
  const upper = doc.rows[index];
  const lower = doc.rows[index + 1];
  if (!upper || !lower) return doc;
  const merged: TranscriptRow = {
    ...upper,
    startMs: Math.min(upper.startMs, lower.startMs),
    endMs: Math.max(upper.endMs, lower.endMs),
    text: joinText(upper.text, lower.text),
  };
  const rows = [...doc.rows.slice(0, index), merged, ...doc.rows.slice(index + 2)];
  return pruneUnusedSpeakers({ ...doc, rows });
}

export function mergeWithNext(doc: EditableDoc, rowId: string): EditableDoc {
  const index = doc.rows.findIndex((r) => r.id === rowId);
  return index < 0 ? doc : mergeAt(doc, index);
}

export function mergeWithPrevious(doc: EditableDoc, rowId: string): EditableDoc {
  const index = doc.rows.findIndex((r) => r.id === rowId);
  return index <= 0 ? doc : mergeAt(doc, index - 1);
}
