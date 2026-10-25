// In-browser stand-in for the server API, used by the static demo build (GitHub Pages),
// where there is no backend. Transcription is simulated with the same deterministic mock
// conversation as the server's mock provider; history lives in IndexedDB; exports are
// rendered in the browser with the server's exporters.
import { buildDocument } from '../../server/segmentation';
import { findDocumentProblems } from '../../shared/document';
import { ERROR_MESSAGES } from '../../shared/errors';
import { generateMockSegments } from '../../shared/mockTranscript';
import {
  DEFAULT_QUALITY_MODE,
  DEFAULT_ULTRA_DAILY_LIMIT,
  isQualityMode,
  nextUtcMidnight,
  qualityModeInfo,
  utcDay,
} from '../../shared/quality';
import { makeId } from '../../shared/speakers';
import {
  ACCEPTED_EXTENSIONS,
  DEFAULT_MAX_UPLOAD_BYTES,
  type AppConfigResponse,
  type ErrorCode,
  type ExportFormat,
  type ModeUsage,
  type QualityMode,
  type SaveDocumentRequest,
  type TranscriptDetail,
  type TranscriptDocument,
  type TranscriptStatus,
  type TranscriptSummary,
  type UsageResponse,
} from '../../shared/types';
import { ApiError } from '../apiError';
import { getDemoStore, type DemoRecord } from './store';

const QUEUE_MS = 600;
const SEPARATING_MS = 1200;
const MAX_SPEAKERS = 10;
const LIMITS: Record<QualityMode, number | null> = {
  standard: null,
  high: null,
  ultra: DEFAULT_ULTRA_DAILY_LIMIT,
};
const QUALITY_TIME_FACTOR: Record<QualityMode, number> = { standard: 0.6, high: 1, ultra: 1.5 };

export const DEMO_CONFIG: AppConfigResponse = {
  provider: 'mock',
  providerConfigured: true,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  acceptedExtensions: ACCEPTED_EXTENSIONS,
  supportsSpeakerCount: true,
  maxSpeakers: MAX_SPEAKERS,
  demoMode: true,
  qualityModes: qualityModeInfo(LIMITS),
  defaultQuality: DEFAULT_QUALITY_MODE,
};

// Finished uses per UTC day and mode, kept in localStorage (the demo has no server to enforce
// limits, so this is per browser). Jobs still "processing" are counted from the records.
const usageKey = (day: string, mode: QualityMode) => `speaker-transcriber-demo:usage:${day}:${mode}`;

function finishedUses(day: string, mode: QualityMode): number {
  try {
    return Number(localStorage.getItem(usageKey(day, mode))) || 0;
  } catch {
    return 0;
  }
}

function recordFinishedUse(day: string, mode: QualityMode): void {
  try {
    localStorage.setItem(usageKey(day, mode), String(finishedUses(day, mode) + 1));
  } catch {
    // Storage unavailable: the limit just isn't remembered across reloads.
  }
}

async function modeUsage(mode: QualityMode, day: string, now = Date.now()): Promise<ModeUsage> {
  const limit = LIMITS[mode];
  const records = await (await getDemoStore()).all();
  const pending = records.filter(
    (r) =>
      r.quality === mode &&
      r.quotaDay === day &&
      !r.final &&
      stageAt(r, now) !== 'done' &&
      stageAt(r, now) !== 'error',
  ).length;
  const used = finishedUses(day, mode) + pending;
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

export async function getUsage(): Promise<UsageResponse> {
  const now = Date.now();
  const day = utcDay(now);
  const entries = await Promise.all(
    (Object.keys(LIMITS) as QualityMode[]).map(
      async (mode) => [mode, await modeUsage(mode, day, now)] as const,
    ),
  );
  return {
    day,
    resetsAt: nextUtcMidnight(now),
    modes: Object.fromEntries(entries) as UsageResponse['modes'],
  };
}

function fail(code: ErrorCode, message: string = ERROR_MESSAGES[code], status = 400): never {
  throw new ApiError(code, message, status);
}

function simulatedTranscribeMs(durationSec: number | null, quality: QualityMode): number {
  const base = Math.min(12_000, Math.max(3_000, 2_500 + (durationSec ?? 60) * 40));
  return Math.round(base * QUALITY_TIME_FACTOR[quality]);
}

function stageAt(rec: DemoRecord, now: number): TranscriptStatus {
  if (rec.final) return rec.final;
  const t = now - rec.timelineStartMs;
  if (t < QUEUE_MS) return 'queued';
  if (t < QUEUE_MS + rec.transcribeMs) return 'transcribing';
  if (rec.outcome !== 'ok') return 'error';
  if (t < QUEUE_MS + rec.transcribeMs + SEPARATING_MS) return 'separating';
  return 'done';
}

const audioUrls = new Map<string, string>();

function forgetAudioUrl(id: string): void {
  const url = audioUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  audioUrls.delete(id);
}

/** Brings a record up to date: once its simulated job has finished, produce the result. */
async function settle(rec: DemoRecord, now = Date.now()): Promise<DemoRecord> {
  const stage = stageAt(rec, now);
  if (rec.final || (stage !== 'done' && stage !== 'error')) return rec;
  const finishedAt = new Date(now).toISOString();
  if (stage === 'error') {
    rec.final = 'error';
    rec.error =
      rec.outcome === 'nospeech'
        ? { code: 'NO_SPEECH', message: ERROR_MESSAGES.NO_SPEECH }
        : {
            code: 'TRANSCRIPTION_FAILED',
            message: 'The transcription service could not process this audio.',
            detail: 'Simulated failure: the file name contains "fail".',
          };
  } else {
    const seed = Math.round((rec.durationSec ?? 60) * 1000) ^ rec.sizeBytes;
    const { speakers, rows } = buildDocument(
      generateMockSegments(rec.durationSec ?? 60, rec.speakersExpected ?? 2, seed),
    );
    rec.final = 'done';
    rec.document = { version: 1, speakers, rows };
    if (LIMITS[rec.quality] != null) recordFinishedUse(rec.quotaDay, rec.quality);
    rec.languageCode = 'en';
    rec.completedAt = finishedAt;
  }
  rec.updatedAt = finishedAt;
  const store = await getDemoStore();
  // Same policy as the server: the audio is deleted after processing unless the user kept it.
  if (!rec.keepAudio && rec.hasAudio) {
    rec.hasAudio = false;
    await store.deleteAudio(rec.id);
    forgetAudioUrl(rec.id);
  }
  await store.put(rec);
  return rec;
}

function toSummary(rec: DemoRecord, now = Date.now()): TranscriptSummary {
  return {
    id: rec.id,
    title: rec.title,
    originalFilename: rec.originalFilename,
    mimeType: rec.mimeType,
    sizeBytes: rec.sizeBytes,
    durationSec: rec.durationSec,
    status: stageAt(rec, now),
    provider: 'mock',
    quality: rec.quality,
    languageCode: rec.languageCode,
    speakersExpected: rec.speakersExpected,
    speakerCount: rec.document?.speakers.length ?? null,
    rowCount: rec.document?.rows.length ?? null,
    keepAudio: rec.keepAudio,
    audioAvailable: rec.hasAudio,
    error: rec.final === 'error' ? rec.error : null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    completedAt: rec.completedAt,
  };
}

function toDetail(rec: DemoRecord, now = Date.now()): TranscriptDetail {
  const summary = toSummary(rec, now);
  const totalMs = rec.transcribeMs + SEPARATING_MS;
  const processingStart = rec.timelineStartMs + QUEUE_MS;
  const active = summary.status === 'transcribing' || summary.status === 'separating';
  return {
    ...summary,
    progress: {
      stage: summary.status,
      startedAt: summary.status === 'queued' ? null : new Date(processingStart).toISOString(),
      elapsedSeconds: active ? Math.max(0, Math.round((now - processingStart) / 1000)) : 0,
      etaSeconds:
        summary.status === 'done' || summary.status === 'error'
          ? 0
          : Math.max(0, Math.round((processingStart + totalMs - now) / 1000)),
      estimatedTotalSeconds: Math.round(totalMs / 1000),
      queuePosition: summary.status === 'queued' ? 1 : null,
    },
    document: summary.status === 'done' ? rec.document : null,
  };
}

async function load(id: string): Promise<DemoRecord> {
  const rec = await (await getDemoStore()).get(id);
  if (!rec) fail('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, 404);
  return settle(rec);
}

export async function getConfig(): Promise<AppConfigResponse> {
  return DEMO_CONFIG;
}

export async function listTranscripts(): Promise<TranscriptSummary[]> {
  const store = await getDemoStore();
  const records = await Promise.all((await store.all()).map((r) => settle(r)));
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => toSummary(r));
}

export async function getTranscript(id: string): Promise<TranscriptDetail> {
  const rec = await load(id);
  if (rec.hasAudio && !audioUrls.has(id)) {
    const blob = await (await getDemoStore()).getAudio(id);
    if (blob) audioUrls.set(id, URL.createObjectURL(blob));
  }
  return toDetail(rec);
}

export async function saveDocument(id: string, req: SaveDocumentRequest): Promise<TranscriptDocument> {
  const rec = await load(id);
  if (rec.final !== 'done' || !rec.document) fail('NOT_READY', ERROR_MESSAGES.NOT_READY, 409);
  const problems = findDocumentProblems(req);
  if (problems.length)
    throw new ApiError('INVALID_INPUT', ERROR_MESSAGES.INVALID_INPUT, 400, problems.join('; '));
  if (req.baseVersion !== rec.document.version) {
    throw new ApiError('VERSION_CONFLICT', ERROR_MESSAGES.VERSION_CONFLICT, 409, undefined, {
      document: rec.document,
    });
  }
  rec.document = { version: rec.document.version + 1, speakers: req.speakers, rows: req.rows };
  rec.updatedAt = new Date().toISOString();
  await (await getDemoStore()).put(rec);
  return rec.document;
}

export async function updateTranscript(id: string, changes: { title?: string }): Promise<TranscriptSummary> {
  const rec = await load(id);
  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (!title || title.length > 200) fail('INVALID_INPUT', 'The title must be 1–200 characters.');
    rec.title = title;
    rec.updatedAt = new Date().toISOString();
    await (await getDemoStore()).put(rec);
  }
  return toSummary(rec);
}

export async function deleteTranscript(id: string): Promise<void> {
  const store = await getDemoStore();
  if (!(await store.get(id))) fail('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, 404);
  await store.delete(id);
  await store.deleteAudio(id);
  forgetAudioUrl(id);
}

export async function deleteAudio(id: string): Promise<TranscriptSummary> {
  const rec = await load(id);
  const store = await getDemoStore();
  await store.deleteAudio(id);
  forgetAudioUrl(id);
  rec.hasAudio = false;
  rec.updatedAt = new Date().toISOString();
  await store.put(rec);
  return toSummary(rec);
}

export async function retryTranscript(id: string): Promise<TranscriptSummary> {
  const rec = await load(id);
  if (rec.final !== 'error' || !rec.hasAudio) fail('CANNOT_RETRY', ERROR_MESSAGES.CANNOT_RETRY, 409);
  const day = utcDay();
  const usage = await modeUsage(rec.quality, day);
  if (usage.remaining === 0) fail('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, 429);
  Object.assign(rec, {
    final: null,
    error: null,
    quotaDay: day,
    timelineStartMs: Date.now(),
    updatedAt: new Date().toISOString(),
  });
  await (await getDemoStore()).put(rec);
  return toSummary(rec);
}

/** Object URL of the stored audio (available after getTranscript has loaded it), or "". */
export function audioUrl(id: string): string {
  return audioUrls.get(id) ?? '';
}

function fileNameFor(title: string, extension: string): string {
  // No path separators or characters that are reserved in file names.
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'transcript';
  return `${base}.${extension}`;
}

export async function downloadExport(id: string, format: ExportFormat): Promise<void> {
  const rec = await load(id);
  if (rec.final !== 'done' || !rec.document) fail('NOT_READY', ERROR_MESSAGES.NOT_READY, 409);
  const { renderExport } = await import('../../shared/export/render');
  const out = await renderExport(format, {
    title: rec.title,
    originalFilename: rec.originalFilename,
    createdAt: rec.createdAt,
    durationSec: rec.durationSec,
    languageCode: rec.languageCode,
    document: rec.document,
  });
  const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: out.contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(rec.title, out.fileExtension);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Same container signatures the server sniffs for. */
function looksLikeAudio(b: Uint8Array): boolean {
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => b[start + i] === ch.charCodeAt(0));
  return (
    ascii(0, 'ID3') ||
    (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) ||
    (ascii(0, 'RIFF') && ascii(8, 'WAVE')) ||
    ascii(4, 'ftyp') ||
    ascii(0, 'OggS') ||
    ascii(0, 'fLaC') ||
    (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
  );
}

export interface DemoUploadOptions {
  speakersExpected: number | null;
  keepAudio: boolean;
  clientDurationSec: number | null;
  quality?: QualityMode;
}

/** Simulates an upload with progress events, then stores the job. */
export function uploadTranscript(
  file: File,
  options: DemoUploadOptions,
  onProgress: (p: { loaded: number; total: number }) => void,
): { promise: Promise<TranscriptSummary>; abort(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let rejectUpload: ((err: unknown) => void) | undefined;
  let aborted = false;

  const promise = new Promise<TranscriptSummary>((resolve, reject) => {
    rejectUpload = reject;
    (async () => {
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
      if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) fail('UNSUPPORTED_FILE', undefined, 415);
      if (file.size === 0) fail('EMPTY_FILE');
      if (file.size > DEFAULT_MAX_UPLOAD_BYTES) fail('FILE_TOO_LARGE', undefined, 413);
      const s = options.speakersExpected;
      if (s != null && (!Number.isInteger(s) || s < 1 || s > MAX_SPEAKERS)) {
        fail('INVALID_INPUT', `Number of speakers must be between 1 and ${MAX_SPEAKERS}.`);
      }
      const quality = options.quality ?? DEFAULT_QUALITY_MODE;
      if (!isQualityMode(quality)) fail('INVALID_INPUT', 'Unknown quality mode.');
      if (!looksLikeAudio(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) {
        fail('UNSUPPORTED_FILE', undefined, 415);
      }
      // Checked before "uploading" so the user isn't kept waiting for a refusal.
      if ((await modeUsage(quality, utcDay())).remaining === 0) {
        fail('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, 429);
      }

      // Pretend to upload at ~25 MB/s, taking between 0.6 and 3 seconds.
      const durationMs = Math.min(3_000, Math.max(600, (file.size / (25 * 1024 * 1024)) * 1000));
      const started = Date.now();
      await new Promise<void>((done) => {
        timer = setInterval(() => {
          const fraction = Math.min(1, (Date.now() - started) / durationMs);
          onProgress({ loaded: Math.round(file.size * fraction), total: file.size });
          if (fraction >= 1) {
            clearInterval(timer);
            done();
          }
        }, 100);
      });
      if (aborted) return;

      const store = await getDemoStore();
      const now = Date.now();
      const name = file.name.toLowerCase();
      const durationSec =
        options.clientDurationSec != null &&
        Number.isFinite(options.clientDurationSec) &&
        options.clientDurationSec > 0
          ? options.clientDurationSec
          : null;
      const rec: DemoRecord = {
        id: makeId('demo'),
        title:
          file.name
            .replace(/\.[^.]+$/, '')
            .trim()
            .slice(0, 200) || 'Untitled',
        originalFilename: file.name,
        mimeType: file.type || `audio/${ext}`,
        sizeBytes: file.size,
        durationSec,
        speakersExpected: s,
        quality,
        quotaDay: utcDay(now),
        keepAudio: options.keepAudio,
        hasAudio: false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        timelineStartMs: now,
        transcribeMs: simulatedTranscribeMs(durationSec, quality),
        outcome: name.includes('nospeech') ? 'nospeech' : name.includes('fail') ? 'fail' : 'ok',
        final: null,
        completedAt: null,
        languageCode: null,
        error: null,
        document: null,
      };
      // The audio is kept while "processing" (for a retry) and dropped afterwards unless kept.
      try {
        await store.putAudio(rec.id, file);
        rec.hasAudio = true;
      } catch {
        rec.hasAudio = false; // Storage quota exceeded: playback still works this session.
      }
      await store.put(rec);
      resolve(toSummary(rec));
    })().catch(reject);
  });

  return {
    promise,
    abort() {
      if (aborted) return;
      aborted = true;
      if (timer) clearInterval(timer);
      rejectUpload?.(new ApiError('UPLOAD_ABORTED', 'Upload cancelled.', 0));
    },
  };
}
