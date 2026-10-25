import path from 'node:path';
import { Router } from 'express';
import { EXPORT_FORMATS, type AcceptedExtension, type ExportFormat } from '../../shared/types';
import type { AppDeps } from '../app';
import { AppError } from '../errors';
import { exportTranscript } from '../export';
import { attachmentDisposition, downloadFileName } from '../http-utils';
import { AUDIO_CONTENT_TYPES } from '../upload';
import { requireTranscript } from './common';

function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

function audioContentType(extension: string, storedMimeType: string): string {
  return AUDIO_CONTENT_TYPES[extension as AcceptedExtension] ?? storedMimeType;
}

/** /api/transcripts/:id/audio and /api/transcripts/:id/export */
export function downloadsRouter({ repo, storage }: AppDeps): Router {
  const router = Router();

  router.get('/:id/audio', async (req, res, next) => {
    const rec = requireTranscript(repo, req.params.id);
    if (!rec.audioFile || !(await storage.exists(rec.audioFile))) throw new AppError('AUDIO_DELETED');
    // `send` handles Range (206 / Content-Range / 416), conditional requests and HEAD.
    res.sendFile(
      path.resolve(storage.absPath(rec.audioFile)),
      {
        cacheControl: false,
        headers: {
          'Content-Type': audioContentType(rec.extension, rec.mimeType),
          'Cache-Control': 'private',
        },
      },
      (err?: Error & { code?: string; status?: number }) => {
        // Errors after streaming started (typically the player closing the connection) need no reply.
        if (!err || res.headersSent || err.code === 'ECONNABORTED') return;
        next(err.code === 'ENOENT' || err.status === 404 ? new AppError('AUDIO_DELETED') : err);
      },
    );
  });

  router.get('/:id/export', async (req, res) => {
    const rec = requireTranscript(repo, req.params.id);
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : '';
    if (!isExportFormat(format)) {
      throw new AppError('INVALID_INPUT', `Choose an export format: ${EXPORT_FORMATS.join(', ')}.`);
    }
    const document = rec.status === 'done' ? repo.getDocument(rec.id) : null;
    if (!document) throw new AppError('NOT_READY');
    const output = await exportTranscript(format, {
      title: rec.title,
      originalFilename: rec.originalFilename,
      createdAt: rec.createdAt,
      durationSec: rec.durationSec,
      languageCode: rec.languageCode,
      document,
    });
    res.set({
      'Content-Type': output.contentType,
      'Content-Disposition': attachmentDisposition(downloadFileName(rec.title, output.fileExtension)),
    });
    res.send(output.body);
  });

  return router;
}
