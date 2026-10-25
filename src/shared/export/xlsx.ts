import ExcelJS from 'exceljs';
import { speakerColor } from '../speakers';
import { formatDuration } from '../time';
import type { ExportInput } from './render';
import { formatCreated, languageLabel, speakersInOrder, type ExportRow } from './common';

/** Excel refuses to open cells longer than this. */
export const XLSX_MAX_CELL_CHARS = 32_767;

function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

/** Splits text into pieces Excel can hold, preferring to cut at whitespace. */
function splitForCells(text: string): string[] {
  if (text.length <= XLSX_MAX_CELL_CHARS) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > XLSX_MAX_CELL_CHARS) {
    let cut = rest.lastIndexOf(' ', XLSX_MAX_CELL_CHARS);
    if (cut < XLSX_MAX_CELL_CHARS / 2) cut = XLSX_MAX_CELL_CHARS;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export async function toXlsx(rows: ExportRow[], input: ExportInput): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Speaker Transcriber';
  const created = new Date(input.createdAt);
  if (!Number.isNaN(created.getTime())) wb.created = created;
  wb.title = input.title;

  const ws = wb.addWorksheet('Transcript', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: '#', key: 'number', width: 6 },
    { header: 'Speaker', key: 'speaker', width: 22 },
    { header: 'Start', key: 'start', width: 11 },
    { header: 'End', key: 'end', width: 11 },
    { header: 'Text', key: 'text', width: 100 },
  ];
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F6' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFC4CAD3' } } };
  });

  for (const r of rows) {
    // Rows longer than one Excel cell continue on extra lines with the same number/speaker/times.
    for (const text of splitForCells(r.text)) {
      // Values are written as plain strings, so text like "=1+1" is never evaluated as a formula.
      const row = ws.addRow({ number: r.number, speaker: r.speakerName, start: r.start, end: r.end, text });
      row.alignment = { vertical: 'top' };
      row.getCell('text').alignment = { vertical: 'top', wrapText: true };
      row.getCell('speaker').font = {
        bold: true,
        ...(r.colorIndex != null ? { color: { argb: argb(speakerColor(r.colorIndex).base) } } : {}),
      };
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };

  const info = wb.addWorksheet('Info');
  info.columns = [
    { key: 'label', width: 16 },
    { key: 'value', width: 80 },
  ];
  const speakers = speakersInOrder(rows).map((s) => s.name);
  const infoRows: [string, string][] = [
    ['Title', input.title],
    ['Original file', input.originalFilename],
    ['Created', formatCreated(input.createdAt)],
    ['Duration', formatDuration(input.durationSec)],
    ['Language', languageLabel(input.languageCode)],
    ['Speakers', speakers.length ? speakers.join(', ') : '—'],
    ['Rows', String(rows.length)],
  ];
  for (const [label, value] of infoRows) {
    const row = info.addRow({ label, value });
    row.getCell('label').font = { bold: true };
    row.getCell('value').alignment = { wrapText: true, vertical: 'top' };
  }

  // A Node Buffer on the server, an ArrayBuffer in the browser; both become a Uint8Array.
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer | Uint8Array;
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
