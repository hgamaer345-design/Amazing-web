// Test harness for the HTTP layer: a real Express app over an in-memory database, a temp-dir
// audio store and a fake provider/worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { vi, type Mock } from 'vitest';
import { createApp } from '../../src/server/app';
import { loadConfig, type AppConfig } from '../../src/server/config';
import { openDatabase, TranscriptRepository, type NewTranscriptInput, type TranscriptRecord } from '../../src/server/db';
import type { TranscriptionProvider } from '../../src/server/providers/types';
import { AudioStorage } from '../../src/server/storage';
import type { Speaker, TranscriptRow } from '../../src/shared/types';

export interface TestContext {
  app: Express;
  config: AppConfig;
  repo: TranscriptRepository;
  storage: AudioStorage;
  provider: TranscriptionProvider | null;
  worker: { kick: Mock<() => void> };
  /** Manual clock shared by the repository and the app. */
  clock: { now: number; advance(ms: number): void };
  dataDir: string;
  /** Names of the files currently in the uploads directory. */
  uploadedFiles(): string[];
  cleanup(): void;
}

export interface TestContextOptions {
  env?: NodeJS.ProcessEnv;
  /** Pass null to simulate a server without a configured provider. */
  provider?: TranscriptionProvider | null;
  /** Adjust the loaded config (e.g. a tiny `maxUploadBytes`) before the app is created. */
  configure?: (config: AppConfig) => void;
}

export function fakeProvider(overrides: Partial<TranscriptionProvider> = {}): TranscriptionProvider {
  return {
    name: 'mock',
    supportsSpeakerCount: true,
    transcribe: () => Promise.reject(new Error('fake provider: not used by HTTP tests')),
    ...overrides,
  };
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-http-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PUBLIC_DIR: path.join(dataDir, 'public'),
    TRANSCRIPTION_PROVIDER: 'mock',
    ...options.env,
  });
  options.configure?.(config);
  const clock = {
    now: Date.parse('2026-03-01T10:00:00.000Z'),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const db = openDatabase(':memory:');
  const repo = new TranscriptRepository(db, () => clock.now);
  const storage = new AudioStorage(config.uploadsDir);
  storage.ensureDir();
  const provider = options.provider === undefined ? fakeProvider() : options.provider;
  const worker = { kick: vi.fn<() => void>() };
  const app = createApp({ config, repo, storage, provider, worker, now: () => clock.now });
  return {
    app,
    config,
    repo,
    storage,
    provider,
    worker,
    clock,
    dataDir,
    uploadedFiles: () => fs.readdirSync(storage.dir).sort(),
    cleanup() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

let seq = 0;

/** Inserts a queued transcript whose audio file really exists in storage. */
export function seedTranscript(ctx: TestContext, overrides: Partial<NewTranscriptInput> = {}): TranscriptRecord {
  const audioFile = overrides.audioFile ?? ctx.storage.newFileName('wav');
  fs.writeFileSync(ctx.storage.absPath(audioFile), Buffer.alloc(1000, 7));
  seq++;
  return ctx.repo.create({
    id: `t${seq}`,
    title: `Recording ${seq}`,
    originalFilename: `recording-${seq}.wav`,
    mimeType: 'audio/wav',
    extension: 'wav',
    sizeBytes: 1000,
    durationSec: 12,
    provider: 'mock',
    speakersExpected: null,
    keepAudio: true,
    estimatedTotalSeconds: 10,
    ...overrides,
    audioFile,
  });
}

export const SAMPLE_SPEAKERS: Speaker[] = [
  { id: 'spk_1', name: 'Speaker 1', colorIndex: 0 },
  { id: 'spk_2', name: 'Speaker 2', colorIndex: 1 },
];

export const SAMPLE_ROWS: TranscriptRow[] = [
  { id: 'row_1', speakerId: 'spk_1', startMs: 0, endMs: 1500, text: 'Hello there.' },
  { id: 'row_2', speakerId: 'spk_2', startMs: 1600, endMs: 4000, text: 'Hi! How are you?' },
];

/** Runs a seeded transcript through the job queue to "done" (document version 1). */
export function completeTranscript(ctx: TestContext, id: string): TranscriptRecord {
  const claimed = ctx.repo.claimNextJob('test-worker', 60_000);
  if (claimed?.id !== id) throw new Error(`Expected to claim ${id}, got ${claimed?.id ?? 'nothing'}`);
  ctx.repo.markSeparating(id, 'test-worker');
  ctx.repo.completeJob(id, 'test-worker', { speakers: SAMPLE_SPEAKERS, rows: SAMPLE_ROWS, languageCode: 'en' });
  return ctx.repo.get(id)!;
}

/** Runs a seeded transcript through the job queue to "error". */
export function failTranscript(ctx: TestContext, id: string): TranscriptRecord {
  const claimed = ctx.repo.claimNextJob('test-worker', 60_000);
  if (claimed?.id !== id) throw new Error(`Expected to claim ${id}, got ${claimed?.id ?? 'nothing'}`);
  ctx.repo.failJob(id, 'test-worker', { code: 'TRANSCRIPTION_FAILED', message: 'Transcription failed.' });
  return ctx.repo.get(id)!;
}

/** Polls `check` until it returns true (or throws after `timeoutMs`). */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
