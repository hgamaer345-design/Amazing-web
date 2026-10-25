import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { findDocumentProblems, saveDocumentRequestSchema } from '../../shared/document';
import { DEFAULT_QUALITY_MODE, isQualityMode, utcDay } from '../../shared/quality';
import type {
  CreateTranscriptResponse,
  GetTranscriptResponse,
  ListTranscriptsResponse,
  SaveDocumentResponse,
  UpdateTranscriptResponse,
  VersionConflictBody,
} from '../../shared/types';
import type { AppDeps } from '../app';
import type { TranscriptRecord } from '../db';
import { AppError } from '../errors';
import { estimateProcessingSeconds } from '../eta';
import { discardBodyAfterResponse } from '../http-utils';
import { log } from '../logger';
import { clientKey } from '../quota';
import { toDetail, toSummary } from '../serialize';
import { MAX_TITLE_LENGTH, normalizeTitle, receiveUpload } from '../upload';
import { deleteStoredAudio, requireTranscript } from './common';

const MAX_PROBLEMS_IN_DETAIL = 5;

const updateTranscriptSchema = z.object({
  title: z
    .string()
    .transform(normalizeTitle)
    .pipe(
      z
        .string()
        .min(1, 'The title can’t be empty.')
        .max(MAX_TITLE_LENGTH, `The title can be at most ${MAX_TITLE_LENGTH} characters long.`),
    )
    .optional(),
});

/** "a; b; c (and 4 more)" */
function summarize(problems: string[]): string {
  const shown = problems.slice(0, MAX_PROBLEMS_IN_DETAIL).join('; ');
  const more = problems.length - MAX_PROBLEMS_IN_DETAIL;
  return more > 0 ? `${shown} (and ${more} more)` : shown;
}

function zodProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  );
}

const IN_PROGRESS: ReadonlySet<TranscriptRecord['status']> = new Set([
  'queued',
  'transcribing',
  'separating',
]);

/** /api/transcripts — upload, history, editing and lifecycle actions. */
export function transcriptsRouter(deps: AppDeps): Router {
  const { config, repo, storage, provider, worker } = deps;
  const now = deps.now ?? Date.now;
  const router = Router();

  router.post('/', async (req, res) => {
    // Several checks below reject the request before its (possibly huge) body has been read.
    discardBodyAfterResponse(req, res);
    if (!config.providerConfigured || !provider) throw new AppError('PROVIDER_NOT_CONFIGURED');

    // The web client also puts the quality in the query string so a request that is over the
    // daily limit is refused before a possibly huge file is uploaded for nothing.
    const quotaKey = clientKey(req);
    const day = utcDay(now());
    const hinted = typeof req.query.quality === 'string' ? req.query.quality : undefined;
    if (hinted && isQualityMode(hinted)) {
      const limit = config.qualityLimits[hinted];
      if (limit != null && repo.usage(quotaKey, hinted, day, limit).remaining === 0) {
        throw new AppError('QUOTA_EXCEEDED');
      }
    }

    const upload = await receiveUpload(req, storage, {
      maxUploadBytes: config.maxUploadBytes,
      maxSpeakers: config.maxSpeakers,
      defaultQuality: hinted && isQualityMode(hinted) ? hinted : DEFAULT_QUALITY_MODE,
    });
    let rec: TranscriptRecord | null;
    try {
      rec = repo.createWithQuota(
        {
          id: randomUUID(),
          title: upload.title,
          originalFilename: upload.originalFilename,
          mimeType: upload.mimeType,
          extension: upload.extension,
          sizeBytes: upload.sizeBytes,
          durationSec: upload.durationSec,
          provider: provider.name,
          // The hint is meaningless for providers that ignore it; don't record it as if it were used.
          speakersExpected: provider.supportsSpeakerCount ? upload.speakersExpected : null,
          keepAudio: upload.keepAudio,
          audioFile: upload.fileName,
          quality: upload.quality,
          quotaKey,
          quotaDay: day,
          estimatedTotalSeconds: estimateProcessingSeconds(
            provider.name,
            upload.durationSec,
            repo.processingStats(provider.name),
            upload.sizeBytes,
            upload.quality,
          ),
        },
        config.qualityLimits[upload.quality],
      );
    } catch (err) {
      await deleteStoredAudio(storage, upload.fileName);
      throw err;
    }
    if (!rec) {
      await deleteStoredAudio(storage, upload.fileName);
      throw new AppError('QUOTA_EXCEEDED');
    }
    log.info('Transcript queued', {
      id: rec.id,
      sizeBytes: rec.sizeBytes,
      durationSec: rec.durationSec,
      provider: rec.provider,
      quality: rec.quality,
    });
    worker?.kick();
    const body: CreateTranscriptResponse = { transcript: toSummary(rec) };
    res
      .status(201)
      .location(`/api/transcripts/${encodeURIComponent(rec.id)}`)
      .json(body);
  });

  router.get('/', (_req, res) => {
    const body: ListTranscriptsResponse = { transcripts: repo.list().map(toSummary) };
    res.json(body);
  });

  router.get('/:id', (req, res) => {
    const rec = requireTranscript(repo, req.params.id);
    const document = rec.status === 'done' ? repo.getDocument(rec.id) : null;
    const body: GetTranscriptResponse = {
      transcript: toDetail(rec, document, repo.queuePosition(rec.id), now()),
    };
    res.json(body);
  });

  router.patch('/:id', express.json({ limit: '16kb' }), (req, res) => {
    const rec = requireTranscript(repo, req.params.id);
    const parsed = updateTranscriptSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const problems = zodProblems(parsed.error);
      throw new AppError('INVALID_INPUT', parsed.error.issues[0]?.message, { detail: summarize(problems) });
    }
    const { title } = parsed.data;
    const updated = title !== undefined && title !== rec.title ? repo.updateTitle(rec.id, title) : rec;
    if (!updated) throw new AppError('NOT_FOUND');
    const body: UpdateTranscriptResponse = { transcript: toSummary(updated) };
    res.json(body);
  });

  router.delete('/:id', async (req, res) => {
    const rec = repo.delete(req.params.id);
    if (!rec) throw new AppError('NOT_FOUND');
    // A worker processing this job notices on its next lease renewal and aborts.
    if (rec.audioFile) await deleteStoredAudio(storage, rec.audioFile);
    log.info('Transcript deleted', { id: rec.id });
    res.status(204).end();
  });

  router.put('/:id/document', express.json({ limit: '25mb' }), (req, res) => {
    requireTranscript(repo, req.params.id);
    const parsed = saveDocumentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('INVALID_INPUT', 'The transcript could not be saved because it is invalid.', {
        detail: summarize(zodProblems(parsed.error)),
      });
    }
    const { baseVersion, speakers, rows } = parsed.data;
    const problems = findDocumentProblems({ speakers, rows });
    if (problems.length) {
      throw new AppError('INVALID_INPUT', 'The transcript could not be saved because it is invalid.', {
        detail: summarize(problems),
      });
    }
    const result = repo.saveDocument(req.params.id, baseVersion, { speakers, rows });
    if (result.ok) {
      const body: SaveDocumentResponse = { document: result.document };
      res.json(body);
      return;
    }
    switch (result.reason) {
      case 'not_found':
        throw new AppError('NOT_FOUND');
      case 'not_ready':
        throw new AppError('NOT_READY');
      case 'conflict': {
        const conflict = new AppError('VERSION_CONFLICT');
        const body: VersionConflictBody = { ...conflict.toBody(), document: result.document };
        res.status(conflict.status).json(body);
        return;
      }
    }
  });

  router.delete('/:id/audio', async (req, res) => {
    const rec = requireTranscript(repo, req.params.id);
    if (IN_PROGRESS.has(rec.status)) {
      throw new AppError('NOT_READY', 'The audio can’t be deleted while the transcript is being processed.');
    }
    const file = repo.takeAudioFile(rec.id);
    if (file) {
      await deleteStoredAudio(storage, file);
      log.info('Audio deleted', { id: rec.id });
    }
    const updated = requireTranscript(repo, rec.id);
    res.json({ transcript: toSummary(updated) });
  });

  router.post('/:id/retry', async (req, res) => {
    const rec = requireTranscript(repo, req.params.id);
    if (rec.status !== 'error') {
      throw new AppError('CANNOT_RETRY', 'Only transcripts that failed can be retried.');
    }
    if (!rec.audioFile || !(await storage.exists(rec.audioFile))) {
      // The record claimed audio that is gone from disk: correct it so the UI stops offering playback.
      if (rec.audioFile) repo.takeAudioFile(rec.id);
      throw new AppError('CANNOT_RETRY');
    }
    if (!config.providerConfigured || !provider) throw new AppError('PROVIDER_NOT_CONFIGURED');
    const updated = repo.retryWithQuota(rec.id, {
      day: utcDay(now()),
      limit: config.qualityLimits[rec.quality],
    });
    if (updated === 'quota') throw new AppError('QUOTA_EXCEEDED');
    if (!updated) throw new AppError('CANNOT_RETRY');
    repo.setEstimate(
      rec.id,
      estimateProcessingSeconds(
        provider.name,
        rec.durationSec,
        repo.processingStats(provider.name),
        rec.sizeBytes,
        rec.quality,
      ),
    );
    log.info('Transcript queued for retry', { id: rec.id });
    worker?.kick();
    res.json({ transcript: toSummary(updated) });
  });

  return router;
}
