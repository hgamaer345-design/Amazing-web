import type { ExportRow } from './common';

/**
 * Plain text, one "Speaker: text" block per row with a blank line between rows.
 * Rows without text are skipped (there is nothing to read); line breaks inside a row are kept.
 */
export function toTxt(rows: ExportRow[]): string {
  const blocks = rows
    .filter((r) => r.text.trim() !== '')
    .map((r) => `${r.speakerName}: ${r.text.trim()}`);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
