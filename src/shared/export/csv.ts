import type { ExportRow } from './common';

const NEEDS_QUOTES = /[",\r\n]/;
// Spreadsheet apps execute cells starting with these characters as formulas.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function cell(value: string, guardFormula: boolean): string {
  const safe = guardFormula && FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV with CRLF line endings and a UTF-8 BOM (so Excel detects the encoding). */
export function toCsv(rows: ExportRow[]): string {
  const lines = ['#,Speaker,Start,End,Text'];
  for (const r of rows) {
    lines.push(
      [String(r.number), cell(r.speakerName, true), r.start, r.end, cell(r.text, true)].join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
