import { isRtlText, RLM, type ExportRow } from './common';

/**
 * Plain text, one "Speaker: text" block per row with a blank line between rows.
 * Rows without text are skipped (there is nothing to read); line breaks inside a row are kept.
 * Every line of a right-to-left row starts with a right-to-left mark: text viewers lay out each
 * line by its first letter, which would otherwise be the speaker name's.
 */
export function toTxt(rows: ExportRow[]): string {
  const blocks = rows
    .filter((r) => r.text.trim() !== '')
    .map((r) => {
      const block = `${r.speakerName}: ${r.text.trim()}`;
      return isRtlText(r.text, r.lang) ? block.replace(/^/gm, RLM) : block;
    });
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
