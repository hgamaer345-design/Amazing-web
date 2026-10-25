import { z } from 'zod';
import type { Speaker, TranscriptRow } from './types';

export const DOCUMENT_LIMITS = {
  maxSpeakers: 100,
  maxRows: 50_000,
  maxSpeakerNameLength: 80,
  maxRowTextLength: 100_000,
  maxIdLength: 64,
} as const;

const idSchema = z.string().min(1).max(DOCUMENT_LIMITS.maxIdLength);

export const speakerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(DOCUMENT_LIMITS.maxSpeakerNameLength),
  colorIndex: z.number().int().min(0).max(10_000),
});

export const rowSchema = z.object({
  id: idSchema,
  speakerId: idSchema,
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string().max(DOCUMENT_LIMITS.maxRowTextLength),
});

export const saveDocumentRequestSchema = z.object({
  baseVersion: z.number().int().min(0),
  speakers: z.array(speakerSchema).max(DOCUMENT_LIMITS.maxSpeakers),
  rows: z.array(rowSchema).max(DOCUMENT_LIMITS.maxRows),
});

/**
 * Checks cross-field invariants that the schema cannot express. Returns a list of
 * problems (empty when valid):
 *  - speaker ids and row ids are unique
 *  - every row references an existing speaker
 *  - startMs <= endMs for every row
 *  - rows are in chronological order (non-decreasing startMs)
 */
export function findDocumentProblems(doc: { speakers: Speaker[]; rows: TranscriptRow[] }): string[] {
  const problems: string[] = [];
  const speakerIds = new Set<string>();
  for (const s of doc.speakers) {
    if (speakerIds.has(s.id)) problems.push(`Duplicate speaker id "${s.id}"`);
    speakerIds.add(s.id);
  }
  const rowIds = new Set<string>();
  let prevStart = -1;
  doc.rows.forEach((r, i) => {
    if (rowIds.has(r.id)) problems.push(`Duplicate row id "${r.id}"`);
    rowIds.add(r.id);
    if (!speakerIds.has(r.speakerId)) problems.push(`Row ${i + 1} references unknown speaker "${r.speakerId}"`);
    if (r.endMs < r.startMs) problems.push(`Row ${i + 1} ends before it starts`);
    if (r.startMs < prevStart) problems.push(`Row ${i + 1} is out of chronological order`);
    prevStart = r.startMs;
  });
  return problems;
}
