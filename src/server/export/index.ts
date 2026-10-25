import { renderExport, type ExportInput } from '../../shared/export/render';
import type { ExportFormat } from '../../shared/types';

export type { ExportInput };

export interface ExportOutput {
  body: Buffer;
  /** e.g. "text/csv; charset=utf-8" */
  contentType: string;
  /** Without the dot, e.g. "csv" */
  fileExtension: string;
}

/** Server-side export: the shared renderer's bytes as a Node Buffer for the HTTP response. */
export async function exportTranscript(format: ExportFormat, input: ExportInput): Promise<ExportOutput> {
  const { bytes, contentType, fileExtension } = await renderExport(format, input);
  return { body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType, fileExtension };
}
