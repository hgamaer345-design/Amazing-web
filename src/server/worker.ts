import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { ERROR_MESSAGES } from '../shared/errors';
import type { ErrorCode, TranscriptError } from '../shared/types';
import type { AppConfig } from './config';
import type { TranscriptRecord, TranscriptRepository } from './db';
import { estimateProcessingSeconds } from './eta';
import { log } from './logger';
import {
  ProviderError,
  type ProviderResult,
  type TranscribeRequest,
  type TranscriptionProvider,
} from './providers/types';
import { buildDocument } from './segmentation';
import type { AudioStorage } from './storage';

export interface WorkerDeps {
  config: AppConfig;
  repo: TranscriptRepository;
  storage: AudioStorage;
  /** null when transcription is not configured; the worker then never claims jobs. */
  provider: TranscriptionProvider | null;
  now?: () => number;
}

export interface JobWorker {
  /** Starts polling for jobs. Idempotent. */
  start(): void;
  /** Wake idle slots immediately (called after an upload or retry). Safe to call any time. */
  kick(): void;
  /** Stops claiming new jobs and aborts/waits for in-flight ones (their leases expire and they are resumed later). */
  stop(): Promise<void>;
}

/** Delay before retrying after the n-th transient failure (the last value repeats). */
export const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000, 120_000];

// setTimeout overflows (and fires immediately) beyond ~24.8 days.
const MAX_TIMER_MS = 2 ** 31 - 1;

type AbortCause = 'lease_lost' | 'shutdown' | 'timeout';

function jobError(code: ErrorCode, detail?: string, message?: string): TranscriptError {
  return { code, message: message ?? ERROR_MESSAGES[code], ...(detail ? { detail } : {}) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Background job runner. Each of `concurrency` slots repeatedly claims the next job from the
 * database queue and runs it to a terminal state (done / error) or back into the queue
 * (transient failure, shutdown). See docs/ARCHITECTURE.md "Job lifecycle".
 */
export function createWorker(deps: WorkerDeps): JobWorker {
  const { config, repo, storage, provider } = deps;
  const now = deps.now ?? Date.now;
  const { concurrency, pollIntervalMs, leaseMs, maxAttempts, jobTimeoutMs } = config.worker;
  const workerId = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

  let running = false;
  const slots: Promise<void>[] = [];
  const waiters = new Set<() => void>();
  const inFlight = new Map<string, (cause: AbortCause) => void>();

  function idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      waiters.add(done);
    });
  }

  function wakeAll(): void {
    for (const wake of [...waiters]) wake();
  }

  async function deleteAudioFile(file: string | null): Promise<void> {
    if (!file) return;
    try {
      await storage.delete(file);
    } catch (err) {
      log.warn('Could not delete audio file', { file, error: errorText(err) });
    }
  }

  async function cleanupProvider(p: TranscriptionProvider, providerJobId: string | null): Promise<void> {
    if (!providerJobId || !config.deleteProviderData || !p.cleanup) return;
    await p.cleanup(providerJobId);
  }

  /** Terminal outcome reached: drop the audio (unless kept) and the provider's copy. */
  async function cleanup(p: TranscriptionProvider, rec: TranscriptRecord, providerJobId: string | null) {
    if (!rec.keepAudio) await deleteAudioFile(repo.takeAudioFile(rec.id));
    await cleanupProvider(p, providerJobId);
  }

  /** The job is no longer ours. If the user deleted it, remove whatever it left behind. */
  async function handleLost(p: TranscriptionProvider, rec: TranscriptRecord, providerJobId: string | null) {
    if (repo.get(rec.id)) return; // Reclaimed by another worker; it is responsible now.
    log.info('Transcript was deleted while processing', { id: rec.id });
    await deleteAudioFile(rec.audioFile);
    await cleanupProvider(p, providerJobId);
  }

  async function fail(
    p: TranscriptionProvider,
    rec: TranscriptRecord,
    providerJobId: string | null,
    error: TranscriptError,
  ): Promise<void> {
    if (!repo.failJob(rec.id, workerId, error)) {
      await handleLost(p, rec, providerJobId);
      return;
    }
    log.info('Transcript failed', { id: rec.id, code: error.code, detail: error.detail });
    await cleanup(p, rec, providerJobId);
  }

  async function handleError(
    p: TranscriptionProvider,
    rec: TranscriptRecord,
    providerJobId: string | null,
    err: unknown,
    cause: AbortCause | null,
  ): Promise<void> {
    if (cause === 'shutdown') {
      // Not a failure: put it straight back so the next start resumes it without waiting for the lease.
      repo.requeue(rec.id, workerId, 0, { keepProviderJobId: true, refundAttempt: true });
      return;
    }
    if (cause === 'lease_lost') return handleLost(p, rec, providerJobId);
    if (cause === 'timeout') return fail(p, rec, providerJobId, jobError('TRANSCRIPTION_TIMEOUT'));

    if (err instanceof ProviderError) {
      switch (err.kind) {
        case 'auth':
          log.error('Transcription provider rejected the API key', { id: rec.id, status: err.status });
          return fail(p, rec, providerJobId, jobError('PROVIDER_AUTH_FAILED', err.detail));
        case 'no_speech':
          return fail(p, rec, providerJobId, jobError('NO_SPEECH', err.detail));
        case 'failed':
          return fail(
            p,
            rec,
            providerJobId,
            jobError(
              'TRANSCRIPTION_FAILED',
              err.detail ?? err.message,
              'The transcription service could not process this audio.',
            ),
          );
        case 'transient': {
          if (rec.attempts >= maxAttempts) {
            return fail(
              p,
              rec,
              providerJobId,
              jobError(
                'TRANSCRIPTION_FAILED',
                `${err.message}${err.detail ? `: ${err.detail}` : ''}. Gave up after ${rec.attempts} attempts.`,
                'The transcription service is unavailable right now. Please try again later.',
              ),
            );
          }
          const backoff = RETRY_BACKOFF_MS[Math.min(rec.attempts, RETRY_BACKOFF_MS.length) - 1] ?? 5_000;
          const delay = Math.max(backoff, err.retryAfterMs ?? 0);
          log.warn('Transient transcription error; will retry', {
            id: rec.id,
            attempt: rec.attempts,
            delayMs: delay,
            error: err.message,
            detail: err.detail,
          });
          if (!repo.requeue(rec.id, workerId, delay, { keepProviderJobId: err.jobStillValid })) {
            await handleLost(p, rec, providerJobId);
          }
          return;
        }
      }
    }

    log.error('Unexpected error while processing transcript', { id: rec.id, err });
    return fail(
      p,
      rec,
      providerJobId,
      jobError('TRANSCRIPTION_FAILED', 'An unexpected error occurred while processing the transcript.'),
    );
  }

  async function runJob(p: TranscriptionProvider, rec: TranscriptRecord): Promise<void> {
    const controller = new AbortController();
    // An object (rather than a let) so TypeScript doesn't narrow it across the awaits below.
    const state: { cause: AbortCause | null; providerJobId: string | null } = {
      cause: null,
      providerJobId: rec.providerJobId,
    };
    const abort = (cause: AbortCause) => {
      if (state.cause) return;
      state.cause = cause;
      controller.abort();
    };
    inFlight.set(rec.id, abort);

    const heartbeat = setInterval(
      () => {
        try {
          if (!repo.renewLease(rec.id, workerId, leaseMs)) abort('lease_lost');
        } catch (err) {
          log.warn('Could not renew job lease', { id: rec.id, error: errorText(err) });
        }
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref?.();
    const startedAt = rec.startedAt ? Date.parse(rec.startedAt) : now();
    const remainingMs = jobTimeoutMs - (now() - startedAt);
    const timeout = setTimeout(() => abort('timeout'), Math.min(MAX_TIMER_MS, Math.max(0, remainingMs)));
    timeout.unref?.();

    try {
      if (rec.attempts > maxAttempts) {
        await fail(p, rec, state.providerJobId, jobError('TRANSCRIPTION_FAILED', `Gave up after ${maxAttempts} attempts.`));
        return;
      }
      if (remainingMs <= 0) {
        await fail(p, rec, state.providerJobId, jobError('TRANSCRIPTION_TIMEOUT'));
        return;
      }
      repo.setEstimate(
        rec.id,
        estimateProcessingSeconds(p.name, rec.durationSec, repo.processingStats(p.name), rec.sizeBytes, rec.quality),
      );
      log.info('Processing transcript', {
        id: rec.id,
        attempt: rec.attempts,
        resume: !!(state.providerJobId && p.resume),
      });

      let result: ProviderResult;
      if (state.providerJobId && p.resume) {
        result = await p.resume(state.providerJobId, controller.signal);
      } else {
        if (!rec.audioFile || !(await storage.exists(rec.audioFile))) {
          await fail(
            p,
            rec,
            state.providerJobId,
            jobError('TRANSCRIPTION_FAILED', 'The uploaded audio is no longer on the server. Upload the file again.'),
          );
          return;
        }
        // `originalFilename` is an extra field only the mock provider reads (for its test triggers).
        const request: TranscribeRequest & { originalFilename: string } = {
          audioPath: storage.absPath(rec.audioFile),
          mimeType: rec.mimeType,
          sizeBytes: rec.sizeBytes,
          speakersExpected: rec.speakersExpected,
          quality: rec.quality,
          signal: controller.signal,
          originalFilename: rec.originalFilename,
          onJobCreated: (providerJobId) => {
            state.providerJobId = providerJobId;
            if (!repo.setProviderJobId(rec.id, workerId, providerJobId)) abort('lease_lost');
          },
        };
        result = await p.transcribe(request);
      }
      controller.signal.throwIfAborted();

      if (!repo.markSeparating(rec.id, workerId)) abort('lease_lost');
      controller.signal.throwIfAborted();
      // Ultra High rebuilds rows from per-word speaker labels, so rows split exactly where the
      // speaker changes (utterance-level output can lump a quick interjection into a turn).
      const useWords = rec.quality === 'ultra' && result.words?.length;
      const { speakers, rows } = buildDocument(useWords ? result.words! : result.segments);
      if (rows.length === 0) {
        await fail(p, rec, state.providerJobId, jobError('NO_SPEECH'));
        return;
      }
      if (!repo.completeJob(rec.id, workerId, { speakers, rows, languageCode: result.languageCode })) {
        abort('lease_lost');
        controller.signal.throwIfAborted();
      }
      if (rec.durationSec == null && result.durationSec) repo.setDuration(rec.id, result.durationSec);
      log.info('Transcript ready', { id: rec.id, speakers: speakers.length, rows: rows.length });
      await cleanup(p, rec, state.providerJobId);
    } catch (err) {
      await handleError(p, rec, state.providerJobId, err, state.cause);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      inFlight.delete(rec.id);
    }
  }

  async function slotLoop(p: TranscriptionProvider): Promise<void> {
    while (running) {
      let job: TranscriptRecord | undefined;
      try {
        job = repo.claimNextJob(workerId, leaseMs);
      } catch (err) {
        log.error('Could not claim a job', { error: errorText(err) });
      }
      if (!job) {
        await idle(pollIntervalMs);
        continue;
      }
      try {
        await runJob(p, job);
      } catch (err) {
        // Keep the slot alive whatever happens; the job's lease will expire and it is retried.
        log.error('Job runner crashed', { id: job.id, err });
      }
    }
  }

  return {
    start() {
      if (running || !provider) return;
      running = true;
      for (let i = 0; i < concurrency; i++) slots.push(slotLoop(provider));
      log.info('Worker started', { workerId, provider: provider.name, concurrency });
    },
    kick() {
      wakeAll();
    },
    async stop() {
      if (!running) return;
      running = false;
      wakeAll();
      for (const abort of inFlight.values()) abort('shutdown');
      await Promise.all(slots.splice(0));
    },
  };
}
