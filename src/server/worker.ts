import type { AppConfig } from './config';
import type { TranscriptRepository } from './db';
import type { TranscriptionProvider } from './providers/types';
import type { AudioStorage } from './storage';

export interface WorkerDeps {
  config: AppConfig;
  repo: TranscriptRepository;
  storage: AudioStorage;
  /** null when transcription is not configured; the worker then never claims jobs. */
  provider: TranscriptionProvider | null;
}

export interface JobWorker {
  /** Starts polling for jobs. Idempotent. */
  start(): void;
  /** Wake idle slots immediately (called after an upload or retry). Safe to call any time. */
  kick(): void;
  /** Stops claiming new jobs and aborts/waits for in-flight ones (their leases expire and they are resumed later). */
  stop(): Promise<void>;
}

/** STUB — implemented by the worker/providers team. */
export function createWorker(deps: WorkerDeps): JobWorker {
  void deps;
  throw new Error('createWorker: not implemented yet');
}
