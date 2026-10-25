import type { ExportFormat, TranscriptDocument } from '../../shared/types';
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

export interface ExportOutput {
  body: Buffer;
  /** e.g. "text/csv; charset=utf-8" */
  contentType: string;
  /** Without the dot, e.g. "csv" */
  fileExtension: string;
}

/**
 * Renders a transcript in the requested format. Tabular formats (CSV, XLSX, DOCX) keep every
 * row so "#" matches the table in the app; TXT and SRT skip rows that have no text.
 */
export async function exportTranscript(format: ExportFormat, input: ExportInput): Promise<ExportOutput> {
  const rows = buildExportRows(input.document);
  switch (format) {
    case 'csv':
      return { body: Buffer.from(toCsv(rows), 'utf8'), contentType: 'text/csv; charset=utf-8', fileExtension: 'csv' };
    case 'txt':
      return { body: Buffer.from(toTxt(rows), 'utf8'), contentType: 'text/plain; charset=utf-8', fileExtension: 'txt' };
    case 'srt':
      return {
        body: Buffer.from(toSrt(rows), 'utf8'),
        contentType: 'application/x-subrip; charset=utf-8',
        fileExtension: 'srt',
      };
    case 'xlsx':
      return {
        body: await toXlsx(rows, input),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileExtension: 'xlsx',
      };
    case 'docx':
      return {
        body: await toDocx(rows, input),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileExtension: 'docx',
      };
    default: {
      const unreachable: never = format;
      throw new Error(`Unsupported export format: ${String(unreachable)}`);
    }
  }
}
