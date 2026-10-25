import { formatHms } from '../time';
import type { TranscriptDocument } from '../types';

export const UNKNOWN_SPEAKER = 'Unknown speaker';

/** A transcript row resolved for export: speaker name looked up, times formatted. */
export interface ExportRow {
  /** 1-based row number, matching the "#" column in the UI. */
  number: number;
  speakerName: string;
  /** null when the row references a speaker that no longer exists. */
  colorIndex: number | null;
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  text: string;
}

// Characters that are not allowed in XML 1.0 (they would corrupt DOCX/XLSX files) plus lone surrogates.
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes characters that can't appear in office documents and normalises line endings to "\n". */
export function sanitizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(INVALID_XML_CHARS, '');
}

export function buildExportRows(doc: TranscriptDocument): ExportRow[] {
  const speakers = new Map(doc.speakers.map((s) => [s.id, s]));
  return doc.rows.map((row, i) => {
    const speaker = speakers.get(row.speakerId);
    return {
      number: i + 1,
      speakerName: speaker ? sanitizeText(speaker.name).trim() || UNKNOWN_SPEAKER : UNKNOWN_SPEAKER,
      colorIndex: speaker ? speaker.colorIndex : null,
      startMs: row.startMs,
      endMs: row.endMs,
      start: formatHms(row.startMs),
      end: formatHms(row.endMs),
      text: sanitizeText(row.text),
    };
  });
}

/** Speaker names in order of first appearance in the rows (speakers without rows are left out). */
export function speakersInOrder(rows: ExportRow[]): { name: string; colorIndex: number | null }[] {
  const seen = new Map<string, { name: string; colorIndex: number | null }>();
  for (const r of rows) {
    if (!seen.has(r.speakerName)) seen.set(r.speakerName, { name: r.speakerName, colorIndex: r.colorIndex });
  }
  return [...seen.values()];
}

/** "en" -> "English (en)", "en_us" -> "English (United States) (en_us)", null -> "Unknown". */
export function languageLabel(code: string | null): string {
  if (!code) return 'Unknown';
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    const name = names.of(code.replace(/_/g, '-'));
    if (name && name.toLowerCase() !== code.toLowerCase()) return `${name} (${code})`;
  } catch {
    // Not a valid BCP 47 tag; fall through to the raw code.
  }
  return code;
}

/** "2026-01-31T14:05:00.000Z" -> "2026-01-31 14:05 UTC" (unambiguous in any locale). */
export function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
