// In-browser stand-in for the server API, used by the static demo build (GitHub Pages), where
// there is no backend. Audio is transcribed on this device: speaker diarization (pyannote
// segmentation + WeSpeaker) and Whisper run in a Web Worker (see ./speech). History lives in
// IndexedDB and exports are rendered in the browser with the server's exporters.
import { buildDocument } from '../../server/segmentation';
import { findDocumentProblems } from '../../shared/document';
import { ERROR_MESSAGES } from '../../shared/errors';
import { isWhisperLanguage } from '../../shared/languages';
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
  type TranscriptRow,
  type TranscriptStatus,
  type TranscriptSummary,
  type UsageResponse,
} from '../../shared/types';
import { ApiError } from '../apiError';
import type { SpeechEngine } from './speech/engine';
import type { SpeechProgress, SpeechSegment, SpeechStage } from './speech/protocol';
import { LITE_DEVICE } from './device';
import { getDemoStore, type DemoRecord } from './store';

const MAX_SPEAKERS = 10;
/**
 * Longest recording the in-browser engine takes: the whole file is decoded in memory at once, and
 * phones give a page far less memory than computers.
 */
export const MAX_DEMO_DURATION_SEC = (LITE_DEVICE ? 20 : 90) * 60;
const LIMITS: Record<QualityMode, number | null> = {
  standard: null,
  high: null,
  ultra: DEFAULT_ULTRA_DAILY_LIMIT,
};

/** What each mode means when everything runs in the browser. */
const BROWSER_MODES: Record<QualityMode, Pick<QualityModeInfo, 'tagline' | 'description'>> = {
  standard: {
    tagline: 'Fast · Whisper Tiny (about 90 MB to download the first time)',
    description:
      'The smallest speech model: quickest, and good for clear recordings. Speaker separation is the same in every mode.',
  },
  high: {
    tagline: 'Accurate · Whisper Base (about 125 MB to download the first time)',
    description:
      'A larger speech model that makes fewer mistakes. The best balance of speed and accuracy for most recordings.',
  },
  ultra: {
    tagline: 'Most accurate · Whisper Small (about 300 MB to download the first time)',
    description:
      'The most accurate speech model, for accents, noise and fast talk. Several times slower than High: ' +
      'best on a computer.',
  },
};

/** Speech in other languages gets the model that suits it (see speech/routing.ts). */
const LANGUAGES_NOTE =
  ' Other languages than English may use a larger model made for them, downloaded the first time.';
/** On phones, the larger models can exhaust the memory a browser tab is allowed. */
const PHONE_NOTE = ' On a phone it can run out of memory: Standard is recommended here.';
/** Phones never run Whisper Small (speech/routing.ts LITE_MAX_WHISPER). */
const PHONE_ULTRA_NOTE =
  ' On a phone it uses Whisper Base, as Whisper Small needs more memory than a phone gives a web page.';

export const DEMO_CONFIG: AppConfigResponse = {
  provider: 'mock',
  providerConfigured: true,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  acceptedExtensions: ACCEPTED_EXTENSIONS,
  supportsSpeakerCount: true,
  maxSpeakers: MAX_SPEAKERS,
  demoMode: true,
  qualityModes: qualityModeInfo(LIMITS).map((m) => {
    const info = { ...m, ...BROWSER_MODES[m.id] };
    info.description += LANGUAGES_NOTE;
    if (LITE_DEVICE && m.id !== 'standard')
      info.description += m.id === 'ultra' ? PHONE_ULTRA_NOTE : PHONE_NOTE;
    return info;
  }),
  // Whisper Tiny is the one that comfortably fits a phone's memory.
  defaultQuality: LITE_DEVICE ? 'standard' : DEFAULT_QUALITY_MODE,
};

// ---------------------------------------------------------------------------
// Speech engine (loaded on first use so the models' code isn't in the main bundle)
// ---------------------------------------------------------------------------

let engineOverride: SpeechEngine | null = null;
let enginePromise: Promise<SpeechEngine> | null = null;

/** Tests: forget this tab's in-memory state, as if the page had been reloaded. */
export function resetDemoStateForTests(): void {
  live.clear();
  sessionAudio.clear();
  current = null;
  started = false;
}

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
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), {
        code: 'ENGINE_START',
      });
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
  /**
   * Model loading after that (another language's model, mid-job): ongoing since `pausedAt`, and
   * the time it took so far. Download time says nothing about how long the rest takes.
   */
  pausedAt: number | null;
  pausedMs: number;
  /** Where the current stage began, in measured time and job fraction. */
  phase: { stage: SpeechStage; atMs: number; fraction: number } | null;
  /** Remaining time estimated at the last progress report, counted down in between. */
  eta: { seconds: number; at: number } | null;
  cancelled: boolean;
  /** Stops the engine once it is running. */
  stop: (() => void) | null;
}

/**
 * Seconds left of a job `fraction` done after `activeMs` of measured time, or null when too
 * little is known. Once the current stage has moved 5 % of the job, its own pace is used: how
 * fast transcription goes depends on the models the recording's languages need, which speaker
 * analysis says nothing about.
 */
export function estimateRemaining(
  activeMs: number,
  fraction: number,
  phase: { atMs: number; fraction: number } | null,
): number | null {
  if (!(fraction > 0.03 && fraction < 1) || activeMs <= 0) return null;
  if (phase && fraction - phase.fraction >= 0.05 && activeMs > phase.atMs) {
    return ((activeMs - phase.atMs) / 1000 / (fraction - phase.fraction)) * (1 - fraction);
  }
  return (activeMs / 1000 / fraction) * (1 - fraction);
}

/** Updates a job's clock and ETA from a progress report. */
function track(job: LiveJob, progress: SpeechProgress, now: number): void {
  job.progress = progress;
  if (progress.stage === 'loading') {
    if (job.measuredSince != null && job.pausedAt == null) job.pausedAt = now;
    return;
  }
  job.measuredSince ??= now;
  if (job.pausedAt != null) {
    job.pausedMs += now - job.pausedAt;
    job.pausedAt = null;
  }
  const f = progress.fraction;
  if (f == null) return;
  const active = now - job.measuredSince - job.pausedMs;
  if (job.phase?.stage !== progress.stage) job.phase = { stage: progress.stage, atMs: active, fraction: f };
  const seconds = estimateRemaining(active, f, job.phase);
  if (seconds != null) job.eta = { seconds, at: now };
}

/**
 * A run that ended without the page closing normally crashed the tab (usually out of memory on a
 * phone). Restarting it on the next load would just crash again, so it isn't retried automatically.
 */
const MAX_ATTEMPTS = 1;
const live = new Map<string, LiveJob>();
/** Uploaded files kept in memory in case storing them in IndexedDB failed (quota). */
const sessionAudio = new Map<string, Blob>();
/** Id of the record this tab is processing, and of that processing run. */
let current: string | null = null;
let currentRun: string | null = null;

/**
 * Closing the tab stops the job (it runs here, not on a server): ask first, and remember that the
 * run ended because the page was closed, so it isn't counted like a crash (see recoverInterrupted).
 */
const CLOSED_RUN_KEY = 'speaker-transcriber-demo:closed-run:';
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (current) event.preventDefault();
  });
  window.addEventListener('pagehide', () => {
    if (!currentRun) return;
    try {
      localStorage.setItem(CLOSED_RUN_KEY + currentRun, '1');
    } catch {
      // Without storage the run just counts as an attempt.
    }
  });
}

function closedNormally(runId: string | null | undefined): boolean {
  if (!runId) return false;
  try {
    const closed = localStorage.getItem(CLOSED_RUN_KEY + runId) !== null;
    localStorage.removeItem(CLOSED_RUN_KEY + runId);
    return closed;
  } catch {
    return false;
  }
}
let pumping = false;
let pumpAgain = false;
let started = false;

/** Tells other tabs about deletions, so a tab processing that transcript stops. */
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('speaker-transcriber-demo') : null;
channel?.addEventListener('message', (e: MessageEvent<{ type?: string; id?: string }>) => {
  if (e.data?.type === 'deleted' && e.data.id) cancelLive(e.data.id);
});

function cancelLive(id: string): void {
  const job = live.get(id);
  if (!job) return;
  job.cancelled = true;
  job.stop?.();
}

/** Only one tab processes jobs; the others wait for this lock (where the browser supports it). */
function withQueueLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request('speaker-transcriber-demo:queue', fn) : fn();
}

/** Starts processing queued jobs, in upload order, one at a time. */
function kick(): void {
  pumpAgain = true;
  if (pumping) return;
  pumping = true;
  void withQueueLock(async () => {
    while (pumpAgain) {
      pumpAgain = false;
      await recoverInterrupted();
      for (let next = await nextQueued(); next; next = await nextQueued()) await processJob(next);
    }
  })
    .catch(() => {})
    .finally(() => {
      pumping = false;
      if (pumpAgain) kick();
    });
}

/** Called by every API entry point: picks up work left by an earlier visit. */
function ensureStarted(): void {
  if (started) return;
  started = true;
  kick();
}

async function nextQueued(): Promise<DemoRecord | undefined> {
  const records = await (await getDemoStore()).all();
  return records
    .filter((r) => r.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/**
 * Jobs still marked as processing that this tab isn't running were cut short (the page was
 * closed or crashed; while we hold the queue lock no other tab can be running them). They are
 * queued again, unless that already happened too often or their audio is gone.
 */
async function recoverInterrupted(): Promise<void> {
  const store = await getDemoStore();
  for (const rec of await store.all()) {
    if (!ACTIVE.has(rec.status) || rec.status === 'queued' || live.has(rec.id)) continue;
    const closed = closedNormally(rec.runId);
    await store.update(rec.id, (r) => {
      if (!ACTIVE.has(r.status) || r.status === 'queued') return false;
      r.updatedAt = new Date().toISOString();
      r.runId = null;
      // The tab was closed (not crashed): that run doesn't count towards giving up.
      if (closed) r.attempts = Math.max(0, (r.attempts ?? 1) - 1);
      if (!r.hasAudio && !sessionAudio.has(r.id)) {
        r.status = 'error';
        r.error = jobError(
          'TRANSCRIPTION_FAILED',
          'Processing was interrupted when the page was closed. Upload the file again.',
        );
      } else if ((r.attempts ?? 0) >= MAX_ATTEMPTS) {
        r.status = 'error';
        r.error = jobError(
          'TRANSCRIPTION_FAILED',
          'The page stopped while transcribing this file, most likely because the device ran out of memory. ' +
            'Try the Standard quality or a shorter recording, or use a computer.',
        );
      } else {
        r.status = 'queued';
        r.startedAt = null;
      }
    });
  }
}

function jobError(code: ErrorCode, message?: string, detail?: string): TranscriptError {
  return { code, message: message ?? ERROR_MESSAGES[code], ...(detail ? { detail } : {}) };
}

/** Records the outcome of run `runId`, unless the record was deleted or another run took over. */
async function finish(id: string, runId: string, changes: Partial<DemoRecord>): Promise<boolean> {
  const store = await getDemoStore();
  let dropAudio = false;
  const saved = await store.update(id, (rec) => {
    if (rec.runId !== runId || live.get(id)?.cancelled) return false;
    Object.assign(rec, changes, { updatedAt: new Date().toISOString(), runId: null });
    // As on the server, audio is dropped once the transcript is ready unless the user kept it.
    // After a failure it stays (on this device) so Retry works.
    if (rec.status === 'done' && !rec.keepAudio) {
      dropAudio = true;
      rec.hasAudio = false;
    }
  });
  if (dropAudio) {
    await store.deleteAudio(id);
    sessionAudio.delete(id);
    forgetAudioUrl(id);
  }
  return saved !== undefined;
}

async function processJob(picked: DemoRecord): Promise<void> {
  const id = picked.id;
  // Registered before any await so a delete from now on cancels this job.
  const entry: LiveJob = {
    progress: { stage: 'loading', message: 'Starting…', fraction: null },
    measuredSince: null,
    pausedAt: null,
    pausedMs: 0,
    phase: null,
    eta: null,
    cancelled: false,
    stop: null,
  };
  live.set(id, entry);
  current = id;
  try {
    const store = await getDemoStore();
    const runId = makeId('run');
    const claimed = await store.update(id, (rec) => {
      if (rec.status !== 'queued' || entry.cancelled) return false;
      rec.status = 'transcribing';
      rec.startedAt = new Date().toISOString();
      rec.updatedAt = rec.startedAt;
      rec.error = null;
      rec.runId = runId;
      rec.attempts = (rec.attempts ?? 0) + 1;
    });
    if (!claimed) return;
    currentRun = runId;

    const audio = (await store.getAudio(id).catch(() => undefined)) ?? sessionAudio.get(id);
    if (!audio) {
      await finish(id, runId, {
        status: 'error',
        hasAudio: false,
        error: jobError(
          'TRANSCRIPTION_FAILED',
          'The audio for this transcript is no longer stored. Upload it again.',
        ),
      });
      return;
    }

    try {
      const engine = await speechEngine();
      if (entry.cancelled) return;
      const job = engine.run(
        audio,
        {
          quality: claimed.quality,
          speakersExpected: claimed.speakersExpected,
          language: claimed.requestedLanguage ?? null,
          lite: LITE_DEVICE,
        },
        (progress) => track(entry, progress, Date.now()),
      );
      entry.stop = job.cancel;
      const result = await job.promise;
      const built = buildDocument(result.segments);
      const speakers = built.speakers;
      const rows = withRowLanguages(built.rows, result.segments, result.languageCode);
      if (rows.length === 0) {
        await finish(id, runId, { status: 'error', error: jobError('NO_SPEECH') });
        return;
      }
      // Count the use before the record turns "done" so the daily limit never undercounts.
      const counted = LIMITS[claimed.quality] != null && (await store.get(id))?.runId === runId;
      if (counted) recordFinishedUse(claimed.quotaDay, claimed.quality);
      await finish(id, runId, {
        status: 'done',
        document: { version: 1, speakers, rows },
        languageCode: result.languageCode,
        durationSec: claimed.durationSec ?? result.durationSec,
        completedAt: new Date().toISOString(),
        attempts: 0,
      });
    } catch (err) {
      if (entry.cancelled) return;
      const e = err as { code?: string; message?: string };
      await finish(id, runId, { status: 'error', error: speechError(e.code, e.message) });
    }
  } finally {
    live.delete(id);
    current = null;
    if (currentRun) closedNormally(currentRun); // clears a marker left by a bfcache pagehide
    currentRun = null;
  }
}

const overlapMs = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

function argmax(totals: Map<string, number>): string | null {
  let best: string | null = null;
  for (const [key, value] of totals) if (best === null || value > totals.get(best)!) best = key;
  return best;
}

/**
 * Gives every row its language when the transcript has more than one (speakers in different
 * languages): the language of most of that speaker's speech in the row. With a single language
 * rows carry none, as before: absent means the transcript's languageCode, so such documents (and
 * every older one) stay exactly as they were, and only mixed ones need a per-row language.
 */
export function withRowLanguages(
  rows: TranscriptRow[],
  segments: readonly SpeechSegment[],
  languageCode: string | null,
): TranscriptRow[] {
  const languages = new Set(segments.flatMap((s) => (s.lang && s.text.trim() ? [s.lang] : [])));
  // buildDocument copies the segments' language onto rows; a single-language document drops it.
  if (languages.size <= 1) return rows.map(({ lang: _lang, ...row }) => row);
  // Which speaker each engine label became (buildDocument numbers speakers itself): the one whose
  // rows its segments match best (intersection over union, so a short reply inside someone else's
  // long turn still matches its own row).
  const votes = new Map<string, Map<string, number>>();
  for (const s of segments) {
    const byRow = votes.get(s.speaker) ?? new Map<string, number>();
    votes.set(s.speaker, byRow);
    for (const r of rows) {
      const o = overlapMs(s, r);
      const union = s.endMs - s.startMs + (r.endMs - r.startMs) - o;
      if (o > 0) byRow.set(r.speakerId, (byRow.get(r.speakerId) ?? 0) + o / union);
    }
  }
  const speakerOf = new Map([...votes].map(([label, byRow]) => [label, argmax(byRow)]));
  return rows.map((row) => {
    const totals = new Map<string, number>();
    for (const s of segments) {
      if (!s.lang || speakerOf.get(s.speaker) !== row.speakerId) continue;
      const o = overlapMs(s, row);
      if (o > 0) totals.set(s.lang, (totals.get(s.lang) ?? 0) + o);
    }
    const lang = argmax(totals) ?? languageCode;
    return lang ? { ...row, lang } : row;
  });
}

/**
 * The language the user chose for a recording (ISO 639-1 as Whisper spells it, or "yue" for
 * Cantonese), or null to detect it; "auto" and "" also mean detect.
 */
export function parseRequestedLanguage(value: string | null | undefined): string | null {
  if (value == null) return null;
  const code = value.trim().toLowerCase();
  if (code === '' || code === 'auto') return null;
  if (isWhisperLanguage(code) || code === 'yue') return code;
  fail('INVALID_INPUT', 'Unknown language.');
}

/** What to tell the user for each way the in-browser engine can fail. */
function speechError(code: string | undefined, detail: string | undefined): TranscriptError {
  switch (code) {
    case 'NO_SPEECH':
      return jobError('NO_SPEECH');
    case 'UNREADABLE_AUDIO':
      return jobError(
        'UNREADABLE_AUDIO',
        'This browser couldn’t decode the audio. The file may use a format this browser doesn’t support ' +
          '(try MP3 or WAV, or another browser), or it may be damaged.',
      );
    case 'ENGINE_START':
      return jobError(
        'TRANSCRIPTION_FAILED',
        'The speech engine couldn’t start. If this page has been open for a while, the site may have been ' +
          'updated: reload the page and press Retry.',
        detail,
      );
    case 'MODEL_DOWNLOAD':
      return jobError(
        'TRANSCRIPTION_FAILED',
        'The speech models couldn’t be downloaded. Check your internet connection and try again.',
        detail,
      );
    case 'DECODE_MEMORY':
      return jobError(
        'TRANSCRIPTION_FAILED',
        `This recording is too long to decode on this device. Try a shorter recording, or the full app for ` +
          `long files.`,
        detail,
      );
    case 'OUT_OF_MEMORY':
      return jobError(
        'TRANSCRIPTION_FAILED',
        'This device ran out of memory while transcribing. Try the Standard quality or a shorter recording, ' +
          'or use a computer.',
        detail,
      );
    case 'MODEL_LOAD':
      return jobError(
        'TRANSCRIPTION_FAILED',
        'This device couldn’t start the speech model, usually because it ran out of memory. Close other tabs ' +
          'or choose a lower quality, then try again.',
        detail,
      );
    default:
      return jobError(
        'TRANSCRIPTION_FAILED',
        'Transcription failed in this browser. Please try again, or try a lower quality setting.',
        detail,
      );
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

/**
 * Records from older demo versions: the simulated one stored a timeline instead of a status, and
 * the very first had no quality mode.
 */
function normalize(rec: DemoRecord): DemoRecord {
  if (!isQualityMode(rec.quality)) rec.quality = DEFAULT_QUALITY_MODE;
  rec.quotaDay ??= rec.createdAt.slice(0, 10);
  rec.hasAudio ??= false;
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
    requestedLanguage: rec.requestedLanguage ?? null,
    speakersExpected: rec.speakersExpected,
    speakerCount: rec.document?.speakers.length ?? null,
    rowCount: rec.document?.rows.length ?? null,
    keepAudio: rec.keepAudio,
    audioAvailable: rec.hasAudio || sessionAudio.has(rec.id),
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
  if (job?.eta) etaSeconds = Math.max(1, Math.round(job.eta.seconds - (now - job.eta.at) / 1000));
  // A model downloading mid-job: its message shows the bytes, the time left is unknown until it runs.
  if (job?.pausedAt != null) etaSeconds = null;
  let queuePosition: number | null = null;
  if (summary.status === 'queued') {
    const queued = (await (await getDemoStore()).all()).filter((r) => r.status === 'queued');
    const ahead = queued.filter((r) => r.createdAt < rec.createdAt && r.id !== current).length;
    queuePosition = ahead + 1 + (current && current !== rec.id ? 1 : 0);
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
  ensureStarted();
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
  ensureStarted();
  const store = await getDemoStore();
  return (await store.all())
    .map(normalize)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSummary);
}

export async function getTranscript(id: string): Promise<TranscriptDetail> {
  const rec = await load(id);
  if ((rec.hasAudio || sessionAudio.has(id)) && !audioUrls.has(id)) {
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
  const document = { version: rec.document.version + 1, speakers: req.speakers, rows: req.rows };
  const saved = await (
    await getDemoStore()
  ).update(id, (r) => {
    if (r.document?.version !== req.baseVersion) return false;
    r.document = document;
    r.updatedAt = new Date().toISOString();
  });
  if (!saved) {
    const latest = await (await getDemoStore()).get(id);
    if (!latest) fail('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, 404);
    throw new ApiError('VERSION_CONFLICT', ERROR_MESSAGES.VERSION_CONFLICT, 409, undefined, {
      document: latest.document,
    });
  }
  return document;
}

export async function updateTranscript(id: string, changes: { title?: string }): Promise<TranscriptSummary> {
  const rec = await load(id);
  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (!title || title.length > 200) fail('INVALID_INPUT', 'The title must be 1–200 characters.');
    const saved = await (
      await getDemoStore()
    ).update(id, (r) => {
      r.title = title;
      r.updatedAt = new Date().toISOString();
    });
    if (!saved) fail('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, 404);
    return toSummary(normalize(saved));
  }
  return toSummary(rec);
}

export async function deleteTranscript(id: string): Promise<void> {
  const store = await getDemoStore();
  if (!(await store.get(id))) fail('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, 404);
  // Stop processing first (here or in another tab), so nothing writes the record back.
  cancelLive(id);
  channel?.postMessage({ type: 'deleted', id });
  await store.delete(id);
  await store.deleteAudio(id);
  sessionAudio.delete(id);
  forgetAudioUrl(id);
}

export async function deleteAudio(id: string): Promise<TranscriptSummary> {
  const rec = await load(id);
  const store = await getDemoStore();
  await store.deleteAudio(id);
  sessionAudio.delete(id);
  forgetAudioUrl(id);
  const saved = await store.update(id, (r) => {
    r.hasAudio = false;
    r.updatedAt = new Date().toISOString();
  });
  return toSummary(normalize(saved ?? { ...rec, hasAudio: false }));
}

export async function retryTranscript(id: string): Promise<TranscriptSummary> {
  const rec = await load(id);
  const hasAudio = rec.hasAudio || sessionAudio.has(id);
  if (rec.status !== 'error' || !hasAudio) fail('CANNOT_RETRY', ERROR_MESSAGES.CANNOT_RETRY, 409);
  const day = utcDay();
  if ((await modeUsage(rec.quality, day)).remaining === 0) {
    fail('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, 429);
  }
  const saved = await (
    await getDemoStore()
  ).update(id, (r) => {
    if (r.status !== 'error') return false;
    Object.assign(r, {
      status: 'queued',
      error: null,
      quotaDay: day,
      startedAt: null,
      attempts: 0,
      runId: null,
      updatedAt: new Date().toISOString(),
    });
  });
  if (!saved) fail('CANNOT_RETRY', ERROR_MESSAGES.CANNOT_RETRY, 409);
  kick();
  return toSummary(normalize(saved));
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
  /**
   * Language of the recording (ISO 639-1 from WHISPER_LANGUAGES, or "yue"); null, absent or "auto"
   * = detect per speaker. Anything else is rejected (INVALID_INPUT).
   */
  language?: string | null;
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
      const requestedLanguage = parseRequestedLanguage(options.language);
      if ((options.clientDurationSec ?? 0) > MAX_DEMO_DURATION_SEC) {
        fail(
          'FILE_TOO_LARGE',
          `The in-browser demo handles recordings up to ${MAX_DEMO_DURATION_SEC / 60} minutes` +
            `${LITE_DEVICE ? ' on this device' : ''}. For longer files, use a computer or the full app with a ` +
            'speech-to-text API key.',
          413,
        );
      }
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
        quotaDay: utcDay(),
        keepAudio: options.keepAudio,
        hasAudio: false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        status: 'queued',
        startedAt: null,
        completedAt: null,
        attempts: 0,
        runId: null,
        requestedLanguage,
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
