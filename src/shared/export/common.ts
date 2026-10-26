import { isRightToLeft } from '../languages';
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
  /** Language of the row's speech: its own (rows of a multi-language transcript) or the transcript's. */
  lang: string | null;
}

// Characters that are not allowed in XML 1.0 (they would corrupt DOCX/XLSX files) plus lone surrogates.
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes characters that can't appear in office documents and normalises line endings to "\n". */
export function sanitizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(INVALID_XML_CHARS, '');
}

/** Rows resolved for export; `languageCode` (the transcript's) stands in for rows without their own. */
export function buildExportRows(doc: TranscriptDocument, languageCode: string | null = null): ExportRow[] {
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
      lang: row.lang || languageCode,
    };
  });
}

/** Letters of the scripts written right to left (Arabic, Hebrew, Syriac, Thaana, N'Ko, Adlam). */
export const RTL_LETTER =
  /[\p{scx=Arabic}\p{scx=Hebrew}\p{scx=Syriac}\p{scx=Thaana}\p{scx=Nko}\p{scx=Adlam}]/u;

/**
 * Whether text is laid out right to left: when most of its letters are of right-to-left scripts,
 * or by its language when it has no letters (or as many of each). The first letter alone, which
 * text editors go by, would make Arabic that starts with "iPhone" left to right.
 */
export function isRtlText(text: string, lang: string | null): boolean {
  if (!RTL_LETTER.test(text)) return !/\p{L}/u.test(text) && isRightToLeft(lang);
  let rtl = 0;
  let letters = 0;
  for (const [letter] of text.matchAll(/\p{L}/gu)) {
    letters++;
    if (RTL_LETTER.test(letter)) rtl++;
  }
  return rtl * 2 === letters ? isRightToLeft(lang) : rtl * 2 > letters;
}

/** Right-to-left mark: starts a line that is right to left, so viewers lay it out that way. */
export const RLM = '\u200F';

/** Languages of the rows: the transcript's first, then in order of appearance. */
export function exportLanguages(rows: ExportRow[], languageCode: string | null): string[] {
  const langs = new Set(rows.map((r) => r.lang).filter((l): l is string => !!l));
  if (!langs.size) return languageCode ? [languageCode] : [];
  return languageCode && langs.has(languageCode)
    ? [languageCode, ...[...langs].filter((l) => l !== languageCode)]
    : [...langs];
}

/** "Language" / "Languages" and their labels: "Arabic (ar), French (fr)", or "Unknown". */
export function languagesField(rows: ExportRow[], languageCode: string | null): [string, string] {
  const langs = exportLanguages(rows, languageCode);
  return [
    langs.length > 1 ? 'Languages' : 'Language',
    langs.length ? langs.map(languageLabel).join(', ') : 'Unknown',
  ];
}

/** Whether the transcript as a whole reads right to left (its main language, else most rows). */
export function isRtlTranscript(rows: ExportRow[], languageCode: string | null): boolean {
  if (languageCode) return isRightToLeft(languageCode);
  const rtl = rows.filter((r) => isRtlText(r.text, r.lang)).length;
  return rtl * 2 > rows.length;
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
