// In-browser stand-in for the server API, used by the static demo build (GitHub Pages), where
// there is no backend. Audio is transcribed on this device: speaker diarization (pyannote
// segmentation + WeSpeaker) and Whisper run in a Web Worker (see ./speech). History lives in
// IndexedDB and exports are rendered in the browser with the server's exporters.
import { buildDocument } from '../../server/segmentation';
import { findDocumentProblems } from '../../shared/document';
import { ERROR_MESSAGES } from '../../shared/errors';
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
  type QualityModeInfo,
  type SaveDocumentRequest,
  type TranscriptDetail,
  type TranscriptDocument,
  type TranscriptError,
  type TranscriptStatus,
  type TranscriptSummary,
  type UsageResponse,
} from '../../shared/types';
import { ApiError } from '../apiError';
import type { SpeechEngine } from './speech/engine';
import type { SpeechProgress } from './speech/protocol';
import { getDemoStore, type DemoRecord } from './store';

const MAX_SPEAKERS = 10;
const LIMITS: Record<QualityMode, number | null> = {
  standard: null,
  high: null,
  ultra: DEFAULT_ULTRA_DAILY_LIMIT,
};

/** What each mode means when everything runs in the browser. */
const BROWSER_MODES: Record<QualityMode, Pick<QualityModeInfo, 'tagline' | 'description'>> = {
  standard: {
    tagline: 'Fast · Whisper Tiny (~40 MB download)',
    description:
      'The smallest Whisper model and quicker speaker analysis. Good for clear recordings with one or two speakers.',
  },
  high: {
    tagline: 'Accurate · Whisper Base (~80 MB download)',
    description:
      'A larger Whisper model and fine-grained speaker analysis. The best balance for most recordings.',
  },
  ultra: {
    tagline: 'Most accurate · Whisper Small (~250 MB download)',
    description:
      'The most accurate model and the most detailed speaker analysis, for difficult audio and fast exchanges. ' +
      'Slower: best on a computer.',
  },
};

export const DEMO_CONFIG: AppConfigResponse = {
  provider: 'mock',
  providerConfigured: true,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  acceptedExtensions: ACCEPTED_EXTENSIONS,
  supportsSpeakerCount: true,
  maxSpeakers: MAX_SPEAKERS,
  demoMode: true,
  qualityModes: qualityModeInfo(LIMITS).map((m) => ({ ...m, ...BROWSER_MODES[m.id] })),
  defaultQuality: DEFAULT_QUALITY_MODE,
};

// ---------------------------------------------------------------------------
// Speech engine (loaded on first use so the models' code isn't in the main bundle)
// ---------------------------------------------------------------------------

let engineOverride: SpeechEngine | null = null;
let enginePromise: Promise<SpeechEngine> | null = null;

/** Tests swap in a fake engine. */
export function setSpeechEngineForTests(engine: SpeechEngine | null): void {
  engineOverride = engine;
}

function speechEngine(): Promise<SpeechEngine> {
  if (engineOverride) return Promise.resolve(engineOverride);
  enginePromise ??= import('./speech/engine')
    .then((m) => m.createBrowserSpeechEngine())
    .catch((err: unknown) => {
      enginePromise = null; // e.g. offline: try loading it again next time
      throw err;
    });
  return enginePromise;
}

// ---------------------------------------------------------------------------
// Daily limits (per browser: the demo has no server to enforce them)
// ---------------------------------------------------------------------------

const usageKey = (day: string, mode: QualityMode) => `speaker-transcriber-demo:usage:${day}:${mode}`;
const ACTIVE: ReadonlySet<TranscriptStatus> = new Set(['queued', 'transcribing', 'separating']);

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

async function modeUsage(mode: QualityMode, day: string): Promise<ModeUsage> {
  const limit = LIMITS[mode];
  const records = await (await getDemoStore()).all();
  const pending = records.filter(
    (r) => r.quality === mode && r.quotaDay === day && ACTIVE.has(r.status),
  ).length;
  const used = finishedUses(day, mode) + pending;
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

export async function getUsage(): Promise<UsageResponse> {
  const now = Date.now();
  const day = utcDay(now);
  const entries = await Promise.all(
    (Object.keys(LIMITS) as QualityMode[]).map(async (mode) => [mode, await modeUsage(mode, day)] as const),
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

// ---------------------------------------------------------------------------
// Job runner: one transcription at a time, in upload order
// ---------------------------------------------------------------------------

interface LiveJob {
  progress: SpeechProgress;
  /** When the measurable part (speaker analysis onwards) began, for the ETA. */
  measuredSince: number | null;
  cancel(): void;
}

const live = new Map<string, LiveJob>();
/** Uploaded files kept in memory in case storing them in IndexedDB failed (quota). */
const sessionAudio = new Map<string, Blob>();
/** Id of the record being processed (set as soon as it is picked from the queue). */
let running: string | null = null;
let resumed = false;

/** Jobs left mid-way by a reload are queued again (their audio is still stored). */
async function resumeInterrupted(): Promise<void> {
  if (resumed) return;
  resumed = true;
  const store = await getDemoStore();
  for (const rec of await store.all()) {
    if (!ACTIVE.has(rec.status) || live.has(rec.id)) continue;
    if (rec.hasAudio) {
      Object.assign(rec, { status: 'queued', startedAt: null });
    } else {
      Object.assign(rec, {
        status: 'error',
        error: {
          code: 'TRANSCRIPTION_FAILED',
          message: 'Processing was interrupted when the page was closed. Upload the file again.',
        },
      });
    }
    await store.put(rec);
  }
  kick();
}

function kick(): void {
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  const store = await getDemoStore();
  const next = (await store.all())
    .filter((r) => r.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) return;
  running = next.id;
  try {
    await processJob(next);
  } finally {
    running = null;
    kick();
  }
}

function jobError(code: ErrorCode, message?: string, detail?: string): TranscriptError {
  return { code, message: message ?? ERROR_MESSAGES[code], ...(detail ? { detail } : {}) };
}

async function finish(id: string, changes: Partial<DemoRecord>): Promise<void> {
  const store = await getDemoStore();
  // Re-read: the title may have been edited, or the record deleted, while processing.
  const rec = await store.get(id);
  if (!rec) return;
  Object.assign(rec, changes, { updatedAt: new Date().toISOString() });
  // As on the server, audio is dropped once the transcript is ready unless the user kept it.
  // After a failure it stays (on this device) so Retry works.
  if (rec.status === 'done' && !rec.keepAudio && rec.hasAudio) {
    rec.hasAudio = false;
    await store.deleteAudio(rec.id);
    sessionAudio.delete(rec.id);
  }
  await store.put(rec);
}

async function processJob(rec: DemoRecord): Promise<void> {
  const store = await getDemoStore();
  const audio = (await store.getAudio(rec.id)) ?? sessionAudio.get(rec.id);
  if (!audio) {
    await finish(rec.id, {
      status: 'error',
      error: jobError(
        'TRANSCRIPTION_FAILED',
        'The audio for this transcript is no longer stored. Upload it again.',
      ),
    });
    return;
  }
  Object.assign(rec, { status: 'transcribing', startedAt: new Date().toISOString(), error: null });
  await store.put(rec);

  let cancelled = false;
  const entry: LiveJob = {
    progress: { stage: 'loading', message: 'Starting…', fraction: null },
    measuredSince: null,
    cancel: () => {
      cancelled = true; // Deleted before the engine started.
    },
  };
  live.set(rec.id, entry);

  try {
    const engine = await speechEngine();
    if (cancelled) return;
    const job = engine.run(
      audio,
      { quality: rec.quality, speakersExpected: rec.speakersExpected },
      (progress) => {
        entry.progress = progress;
        if (progress.stage !== 'loading' && entry.measuredSince == null) entry.measuredSince = Date.now();
      },
    );
    entry.cancel = job.cancel;
    const result = await job.promise;
    const { speakers, rows } = buildDocument(result.segments);
    if (rows.length === 0) {
      await finish(rec.id, { status: 'error', error: jobError('NO_SPEECH') });
      return;
    }
    if (LIMITS[rec.quality] != null && (await store.get(rec.id)))
      recordFinishedUse(rec.quotaDay, rec.quality);
    await finish(rec.id, {
      status: 'done',
      document: { version: 1, speakers, rows },
      languageCode: result.languageCode,
      durationSec: rec.durationSec ?? result.durationSec,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const error =
      e.code === 'NO_SPEECH'
        ? jobError('NO_SPEECH')
        : e.code === 'UNREADABLE_AUDIO'
          ? jobError('UNREADABLE_AUDIO')
          : e.code === 'MODEL_DOWNLOAD'
            ? jobError(
                'TRANSCRIPTION_FAILED',
                'The speech models couldn’t be downloaded. Check your internet connection and try again.',
                e.message,
              )
            : jobError(
                'TRANSCRIPTION_FAILED',
                'Transcription failed in this browser. Please try again, or try a smaller quality setting.',
                e.message,
              );
    await finish(rec.id, { status: 'error', error });
  } finally {
    live.delete(rec.id);
  }
}

// ---------------------------------------------------------------------------
// Records -> API shapes
// ---------------------------------------------------------------------------

const audioUrls = new Map<string, string>();

function forgetAudioUrl(id: string): void {
  const url = audioUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  audioUrls.delete(id);
}

/** Older demo versions stored a simulated timeline; treat those records as finished or failed. */
function normalize(rec: DemoRecord): DemoRecord {
  if (rec.status) return rec;
  const legacy = rec as DemoRecord & { final?: 'done' | 'error' | null };
  rec.status = legacy.final === 'done' && rec.document ? 'done' : 'error';
  rec.startedAt ??= null;
  if (rec.status === 'error' && !rec.error) {
    rec.error = jobError(
      'TRANSCRIPTION_FAILED',
      'This transcript was made with an older demo. Upload it again.',
    );
  }
  return rec;
}

function toSummary(rec: DemoRecord): TranscriptSummary {
  return {
    id: rec.id,
    title: rec.title,
    originalFilename: rec.originalFilename,
    mimeType: rec.mimeType,
    sizeBytes: rec.sizeBytes,
    durationSec: rec.durationSec,
    status: rec.status,
    provider: 'mock',
    quality: rec.quality,
    languageCode: rec.languageCode,
    speakersExpected: rec.speakersExpected,
    speakerCount: rec.document?.speakers.length ?? null,
    rowCount: rec.document?.rows.length ?? null,
    keepAudio: rec.keepAudio,
    audioAvailable: rec.hasAudio,
    error: rec.status === 'error' ? rec.error : null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    completedAt: rec.completedAt,
  };
}

async function toDetail(rec: DemoRecord): Promise<TranscriptDetail> {
  const now = Date.now();
  const summary = toSummary(rec);
  const job = live.get(rec.id);
  const started = rec.startedAt ? Date.parse(rec.startedAt) : null;
  let etaSeconds: number | null = summary.status === 'done' || summary.status === 'error' ? 0 : null;
  const fraction = job?.progress.fraction ?? null;
  if (job?.measuredSince != null && fraction != null && fraction > 0.03 && fraction < 1) {
    const elapsed = (now - job.measuredSince) / 1000;
    etaSeconds = Math.max(1, Math.round((elapsed / fraction) * (1 - fraction)));
  }
  let queuePosition: number | null = null;
  if (summary.status === 'queued') {
    const queued = (await (await getDemoStore()).all()).filter((r) => r.status === 'queued');
    const ahead = queued.filter((r) => r.createdAt < rec.createdAt && r.id !== running).length;
    queuePosition = ahead + 1 + (running && running !== rec.id ? 1 : 0);
  }
  return {
    ...summary,
    progress: {
      stage: summary.status,
      startedAt: rec.startedAt,
      elapsedSeconds: started != null && ACTIVE.has(summary.status) ? Math.round((now - started) / 1000) : 0,
      etaSeconds,
      estimatedTotalSeconds: null,
      queuePosition,
      message: job?.progress.message ?? null,
      fraction,
    },
    document: summary.status === 'done' ? rec.document : null,
  };
}

async function load(id: string): Promise<DemoRecord> {
  await resumeInterrupted();
  const rec = await (await getDemoStore()).get(id);
  if (!rec) fail('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, 404);
  return normalize(rec);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function getConfig(): Promise<AppConfigResponse> {
  return DEMO_CONFIG;
}

export async function listTranscripts(): Promise<TranscriptSummary[]> {
  await resumeInterrupted();
  const store = await getDemoStore();
  return (await store.all())
    .map(normalize)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSummary);
}

export async function getTranscript(id: string): Promise<TranscriptDetail> {
  const rec = await load(id);
  if (rec.hasAudio && !audioUrls.has(id)) {
    const blob = (await (await getDemoStore()).getAudio(id)) ?? sessionAudio.get(id);
    if (blob) audioUrls.set(id, URL.createObjectURL(blob));
  }
  return toDetail(rec);
}

export async function saveDocument(id: string, req: SaveDocumentRequest): Promise<TranscriptDocument> {
  const rec = await load(id);
  if (rec.status !== 'done' || !rec.document) fail('NOT_READY', ERROR_MESSAGES.NOT_READY, 409);
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
  live.get(id)?.cancel();
  sessionAudio.delete(id);
  forgetAudioUrl(id);
}

export async function deleteAudio(id: string): Promise<TranscriptSummary> {
  const rec = await load(id);
  const store = await getDemoStore();
  await store.deleteAudio(id);
  sessionAudio.delete(id);
  forgetAudioUrl(id);
  rec.hasAudio = false;
  rec.updatedAt = new Date().toISOString();
  await store.put(rec);
  return toSummary(rec);
}

export async function retryTranscript(id: string): Promise<TranscriptSummary> {
  const rec = await load(id);
  if (rec.status !== 'error' || !rec.hasAudio) fail('CANNOT_RETRY', ERROR_MESSAGES.CANNOT_RETRY, 409);
  const day = utcDay();
  if ((await modeUsage(rec.quality, day)).remaining === 0) {
    fail('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, 429);
  }
  Object.assign(rec, {
    status: 'queued',
    error: null,
    quotaDay: day,
    startedAt: null,
    updatedAt: new Date().toISOString(),
  });
  await (await getDemoStore()).put(rec);
  kick();
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
  if (rec.status !== 'done' || !rec.document) fail('NOT_READY', ERROR_MESSAGES.NOT_READY, 409);
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

let lastCreatedMs = 0;

export interface DemoUploadOptions {
  speakersExpected: number | null;
  keepAudio: boolean;
  clientDurationSec: number | null;
  quality?: QualityMode;
}

/**
 * "Uploads" by saving the file on this device (nothing leaves the browser), then queues it
 * for transcription.
 */
export function uploadTranscript(
  file: File,
  options: DemoUploadOptions,
  onProgress: (p: { loaded: number; total: number }) => void,
): { promise: Promise<TranscriptSummary>; abort(): void } {
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
      if ((await modeUsage(quality, utcDay())).remaining === 0) {
        fail('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, 429);
      }
      onProgress({ loaded: 0, total: file.size });

      const store = await getDemoStore();
      // Unique, increasing creation times keep the processing order the upload order.
      const now = (lastCreatedMs = Math.max(Date.now(), lastCreatedMs + 1));
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
        status: 'queued',
        startedAt: null,
        completedAt: null,
        languageCode: null,
        error: null,
        document: null,
      };
      // The audio stays on this device until processing finishes (so a reload can resume).
      sessionAudio.set(rec.id, file);
      try {
        await store.putAudio(rec.id, file);
        rec.hasAudio = true;
      } catch {
        rec.hasAudio = false; // Storage full: processing still works while this page is open.
      }
      if (aborted) {
        await store.deleteAudio(rec.id);
        sessionAudio.delete(rec.id);
        return;
      }
      await store.put(rec);
      onProgress({ loaded: file.size, total: file.size });
      resolve(toSummary(rec));
      kick();
    })().catch(reject);
  });

  return {
    promise,
    abort() {
      if (aborted) return;
      aborted = true;
      rejectUpload?.(new ApiError('UPLOAD_ABORTED', 'Upload cancelled.', 0));
    },
  };
}
