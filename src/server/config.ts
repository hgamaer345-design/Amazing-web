import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_UPLOAD_BYTES, type ProviderName } from '../shared/types';

export interface AppConfig {
  port: number;
  host: string;
  /** Root folder for the SQLite database and uploaded audio. */
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  /** Built web client (served in production). */
  publicDir: string;
  maxUploadBytes: number;
  maxSpeakers: number;
  /** Resolved provider, or null if nothing is configured. */
  provider: ProviderName | null;
  /** True when `provider` is set AND has the credentials it needs. */
  providerConfigured: boolean;
  assemblyai: {
    apiKey: string | undefined;
    /** e.g. https://api.assemblyai.com or https://api.eu.assemblyai.com */
    baseUrl: string;
    /** Ordered `speech_models` list; the API falls back to later models for unsupported languages. */
    speechModels: string[];
  };
  deepgram: {
    apiKey: string | undefined;
    baseUrl: string;
    model: string;
    /** `diarize_model` value ("latest", "v1", "v2"). */
    diarizeModel: string;
  };
  mock: {
    /** Simulated processing time in ms. */
    delayMs: number;
  };
  worker: {
    /** Run the job worker inside the web server process. */
    enabled: boolean;
    concurrency: number;
    /** How often idle workers look for new jobs. */
    pollIntervalMs: number;
    /** How often to poll the provider for an async job's status. */
    providerPollIntervalMs: number;
    /** A job whose lease is not renewed within this window is considered abandoned and reclaimed. */
    leaseMs: number;
    /** Max processing attempts for transient (network/5xx/429) failures. */
    maxAttempts: number;
    /** Hard limit on one job's total processing time. */
    jobTimeoutMs: number;
  };
  /** Ask the provider to delete its copy of the transcript/audio once we have the result. */
  deleteProviderData: boolean;
  basicAuth: { user: string; password: string } | null;
  trustProxy: boolean;
}

function int(value: string | undefined, fallback: number, min = 0): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid numeric config value: "${value}"`);
  return Math.floor(n);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function str(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function list(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

const PROVIDERS: readonly ProviderName[] = ['assemblyai', 'deepgram', 'mock'];

/** Loads variables from a .env file if present. Variables already set in the environment win. */
export function loadDotEnv(file = '.env'): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');

  const assemblyKey = str(env.ASSEMBLYAI_API_KEY);
  const deepgramKey = str(env.DEEPGRAM_API_KEY);

  const explicit = str(env.TRANSCRIPTION_PROVIDER)?.toLowerCase();
  let provider: ProviderName | null;
  if (explicit) {
    if (!PROVIDERS.includes(explicit as ProviderName)) {
      throw new Error(
        `TRANSCRIPTION_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${env.TRANSCRIPTION_PROVIDER}")`,
      );
    }
    provider = explicit as ProviderName;
  } else if (assemblyKey) {
    provider = 'assemblyai';
  } else if (deepgramKey) {
    provider = 'deepgram';
  } else {
    provider = null;
  }

  const providerConfigured =
    provider === 'mock' ||
    (provider === 'assemblyai' && !!assemblyKey) ||
    (provider === 'deepgram' && !!deepgramKey);

  const authUser = str(env.BASIC_AUTH_USER);
  const authPassword = str(env.BASIC_AUTH_PASSWORD);
  if ((authUser && !authPassword) || (!authUser && authPassword)) {
    throw new Error('Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, or neither.');
  }

  const maxUploadMb = int(env.MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_BYTES / (1024 * 1024), 1);

  return {
    port: int(env.PORT, 3000, 0),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'transcripts.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    publicDir: path.resolve(env.PUBLIC_DIR ?? './dist/public'),
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxSpeakers: int(env.MAX_SPEAKERS, 10, 1),
    provider,
    providerConfigured,
    assemblyai: {
      apiKey: assemblyKey,
      baseUrl: (str(env.ASSEMBLYAI_BASE_URL) ?? 'https://api.assemblyai.com').replace(/\/+$/, ''),
      speechModels: list(env.ASSEMBLYAI_SPEECH_MODELS) ?? ['universal-3-5-pro', 'universal-2'],
    },
    deepgram: {
      apiKey: deepgramKey,
      baseUrl: (str(env.DEEPGRAM_BASE_URL) ?? 'https://api.deepgram.com').replace(/\/+$/, ''),
      model: str(env.DEEPGRAM_MODEL) ?? 'nova-3',
      diarizeModel: str(env.DEEPGRAM_DIARIZE_MODEL) ?? 'latest',
    },
    mock: {
      delayMs: int(env.MOCK_DELAY_MS, 4000, 0),
    },
    worker: {
      enabled: bool(env.RUN_WORKER, true),
      concurrency: int(env.WORKER_CONCURRENCY, 2, 1),
      pollIntervalMs: int(env.WORKER_POLL_INTERVAL_MS, 1000, 10),
      providerPollIntervalMs: int(env.PROVIDER_POLL_INTERVAL_MS, 3000, 10),
      leaseMs: int(env.JOB_LEASE_MS, 60_000, 1000),
      maxAttempts: int(env.JOB_MAX_ATTEMPTS, 3, 1),
      jobTimeoutMs: int(env.JOB_TIMEOUT_MINUTES, 180, 1) * 60_000,
    },
    deleteProviderData: bool(env.DELETE_PROVIDER_DATA, true),
    basicAuth: authUser && authPassword ? { user: authUser, password: authPassword } : null,
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}
