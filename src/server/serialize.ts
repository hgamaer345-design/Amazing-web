import type {
  TranscriptDetail,
  TranscriptDocument,
  TranscriptProgress,
  TranscriptSummary,
} from '../shared/types';
import type { TranscriptRecord } from './db';

export function toSummary(rec: TranscriptRecord): TranscriptSummary {
  return {
    id: rec.id,
    title: rec.title,
    originalFilename: rec.originalFilename,
    mimeType: rec.mimeType,
    sizeBytes: rec.sizeBytes,
    durationSec: rec.durationSec,
    status: rec.status,
    provider: rec.provider,
    quality: rec.quality,
    languageCode: rec.languageCode,
    requestedLanguage: rec.requestedLanguage,
    speakersExpected: rec.speakersExpected,
    speakerCount: rec.speakerCount,
    rowCount: rec.rowCount,
    keepAudio: rec.keepAudio,
    audioAvailable: rec.audioFile != null,
    error: rec.error,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    completedAt: rec.completedAt,
  };
}

export function buildProgress(
  rec: TranscriptRecord,
  queuePosition: number | null,
  now: number = Date.now(),
): TranscriptProgress {
  const startedMs = rec.startedAt ? Date.parse(rec.startedAt) : null;
  const active = rec.status === 'transcribing' || rec.status === 'separating';
  const elapsedSeconds = active && startedMs != null ? Math.max(0, Math.round((now - startedMs) / 1000)) : 0;
  let etaSeconds: number | null = null;
  if (rec.status === 'done' || rec.status === 'error') etaSeconds = 0;
  else if (rec.estimatedTotalSeconds != null) {
    etaSeconds = Math.max(0, Math.round(rec.estimatedTotalSeconds - elapsedSeconds));
  }
  return {
    stage: rec.status,
    startedAt: rec.startedAt,
    elapsedSeconds,
    etaSeconds,
    estimatedTotalSeconds: rec.estimatedTotalSeconds,
    queuePosition: rec.status === 'queued' ? queuePosition : null,
  };
}

export function toDetail(
  rec: TranscriptRecord,
  document: TranscriptDocument | null,
  queuePosition: number | null,
  now: number = Date.now(),
): TranscriptDetail {
  return {
    ...toSummary(rec),
    progress: buildProgress(rec, queuePosition, now),
    document: rec.status === 'done' ? document : null,
  };
}
