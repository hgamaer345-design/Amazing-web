import type { ExportFormat, TranscriptDocument } from '../../shared/types';

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

/** STUB — implemented by the export team. */
export async function exportTranscript(format: ExportFormat, input: ExportInput): Promise<ExportOutput> {
  void format;
  void input;
  throw new Error('exportTranscript: not implemented yet');
}
