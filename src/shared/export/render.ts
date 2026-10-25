// Renders transcript exports. Environment-neutral (no Node APIs) so the server and the
// static demo build share the same exporters.
import type { ExportFormat, TranscriptDocument } from '../types';
import { buildExportRows } from './common';
import { toCsv } from './csv';
import { toDocx } from './docx';
import { toSrt } from './srt';
import { toTxt } from './txt';
import { toXlsx } from './xlsx';

export interface ExportInput {
  title: string;
  originalFilename: string;
  /** ISO timestamp */
  createdAt: string;
  durationSec: number | null;
  languageCode: string | null;
  document: TranscriptDocument;
}

export interface RenderedExport {
  bytes: Uint8Array;
  /** e.g. "text/csv; charset=utf-8" */
  contentType: string;
  /** Without the dot, e.g. "csv" */
  fileExtension: string;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * Renders a transcript in the requested format. Tabular formats (CSV, XLSX, DOCX) keep every
 * row so "#" matches the table in the app; TXT and SRT skip rows that have no text.
 */
export async function renderExport(format: ExportFormat, input: ExportInput): Promise<RenderedExport> {
  const rows = buildExportRows(input.document);
  switch (format) {
    case 'csv':
      return { bytes: utf8(toCsv(rows)), contentType: 'text/csv; charset=utf-8', fileExtension: 'csv' };
    case 'txt':
      return { bytes: utf8(toTxt(rows)), contentType: 'text/plain; charset=utf-8', fileExtension: 'txt' };
    case 'srt':
      return { bytes: utf8(toSrt(rows)), contentType: 'application/x-subrip; charset=utf-8', fileExtension: 'srt' };
    case 'xlsx':
      return {
        bytes: await toXlsx(rows, input),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileExtension: 'xlsx',
      };
    case 'docx':
      return {
        bytes: await toDocx(rows, input),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileExtension: 'docx',
      };
    default: {
      const unreachable: never = format;
      throw new Error(`Unsupported export format: ${String(unreachable)}`);
    }
  }
}
