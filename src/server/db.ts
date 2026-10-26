import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ErrorCode,
  ModeUsage,
  ProviderName,
  QualityMode,
  Speaker,
  TranscriptDocument,
  TranscriptError,
  TranscriptRow,
  TranscriptStatus,
} from '../shared/types';

export type DB = Database.Database;

/** One transcript job + its result, as stored. The document body is loaded separately. */
export interface TranscriptRecord {
  id: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  /** Lower-case extension without the dot, e.g. "mp3". */
  extension: string;
  sizeBytes: number;
  durationSec: number | null;
  status: TranscriptStatus;
  provider: ProviderName;
  quality: QualityMode;
  /** Anonymous client key the job counts against for daily quality limits (null = not counted). */
  quotaKey: string | null;
  /** UTC day ("YYYY-MM-DD") the job counts against. */
  quotaDay: string | null;
  /** The provider's id for the async job (e.g. AssemblyAI transcript id), used to resume polling. */
  providerJobId: string | null;
  languageCode: string | null;
  /** Language the user chose at upload (ISO 639-1); null = detect automatically. */
  requestedLanguage: string | null;
  speakersExpected: number | null;
  keepAudio: boolean;
  /** Stored file name inside the uploads dir; null once the audio has been deleted. */
  audioFile: string | null;
  error: TranscriptError | null;
  attempts: number;
  leaseOwner: string | null;
  /** Epoch ms. */
  leaseExpiresAt: number | null;
  /** Epoch ms; a queued job is not picked up before this time (retry backoff). */
  notBefore: number | null;
  estimatedTotalSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Wall-clock seconds the successful attempt took (used to improve future estimates). */
  processingSeconds: number | null;
  documentVersion: number;
  speakerCount: number | null;
  rowCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTranscriptInput {
  id: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  durationSec: number | null;
  provider: ProviderName;
  speakersExpected: number | null;
  keepAudio: boolean;
  audioFile: string;
  estimatedTotalSeconds: number | null;
  /** Defaults to "high". */
  quality?: QualityMode;
  /** Client key for daily limits; omit (null) to not count the job. */
  quotaKey?: string | null;
  /** UTC day the job counts against (required with quotaKey). */
  quotaDay?: string | null;
  /** Language the user chose (ISO 639-1); omit (null) to detect it. */
  requestedLanguage?: string | null;
}

export type SaveDocumentResult =
  | { ok: true; document: TranscriptDocument }
  | { ok: false; reason: 'not_found' | 'not_ready' }
  | { ok: false; reason: 'conflict'; document: TranscriptDocument };

const MIGRATIONS: string[] = [
  `
  CREATE TABLE transcripts (
    id                      TEXT PRIMARY KEY,
    title                   TEXT NOT NULL,
    original_filename       TEXT NOT NULL,
    mime_type               TEXT NOT NULL,
    extension               TEXT NOT NULL,
    size_bytes              INTEGER NOT NULL,
    duration_sec            REAL,
    status                  TEXT NOT NULL,
    provider                TEXT NOT NULL,
    provider_job_id         TEXT,
    language_code           TEXT,
    speakers_expected       INTEGER,
    keep_audio              INTEGER NOT NULL DEFAULT 0,
    audio_file              TEXT,
    error_code              TEXT,
    error_message           TEXT,
    error_detail            TEXT,
    attempts                INTEGER NOT NULL DEFAULT 0,
    lease_owner             TEXT,
    lease_expires_at        INTEGER,
    not_before              INTEGER,
    estimated_total_seconds REAL,
    started_at              TEXT,
    completed_at            TEXT,
    processing_seconds      REAL,
    document_json           TEXT,
    document_version        INTEGER NOT NULL DEFAULT 0,
    speaker_count           INTEGER,
    row_count               INTEGER,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );
  CREATE INDEX idx_transcripts_created ON transcripts (created_at DESC);
  CREATE INDEX idx_transcripts_status ON transcripts (status, created_at);
  `,
  `
  ALTER TABLE transcripts ADD COLUMN quality TEXT NOT NULL DEFAULT 'high';
  ALTER TABLE transcripts ADD COLUMN quota_key TEXT;
  ALTER TABLE transcripts ADD COLUMN quota_day TEXT;
  CREATE INDEX idx_transcripts_quota ON transcripts (quota_key, quota_day, quality, status);
  -- Completed jobs per client, day and mode. Never decremented, so deleting a finished
  -- transcript doesn't give a use back.
  CREATE TABLE usage_counters (
    client_key TEXT NOT NULL,
    day        TEXT NOT NULL,
    mode       TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_key, day, mode)
  );
  `,
  // Nullable, so rows created before languages could be chosen read as "detect automatically".
  `
  ALTER TABLE transcripts ADD COLUMN requested_language TEXT;
  `,
];

/** Opens (and migrates) the database. Pass ":memory:" for tests. */
export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// Columns for list/get queries (everything except the potentially large document body).
const RECORD_COLUMNS = `
  id, title, original_filename, mime_type, extension, size_bytes, duration_sec, status, provider,
  quality, quota_key, quota_day, provider_job_id, language_code, requested_language, speakers_expected,
  keep_audio, audio_file, error_code, error_message, error_detail, attempts, lease_owner, lease_expires_at,
  not_before, estimated_total_seconds, started_at, completed_at, processing_seconds, document_version,
  speaker_count, row_count, created_at, updated_at`;

interface Row {
  id: string;
  title: string;
  original_filename: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  duration_sec: number | null;
  status: string;
  provider: string;
  quality: string;
  quota_key: string | null;
  quota_day: string | null;
  provider_job_id: string | null;
  language_code: string | null;
  requested_language: string | null;
  speakers_expected: number | null;
  keep_audio: number;
  audio_file: string | null;
  error_code: string | null;
  error_message: string | null;
  error_detail: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  not_before: number | null;
  estimated_total_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  processing_seconds: number | null;
  document_version: number;
  speaker_count: number | null;
  row_count: number | null;
  created_at: string;
  updated_at: string;
}

function toRecord(r: Row): TranscriptRecord {
  return {
    id: r.id,
    title: r.title,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    extension: r.extension,
    sizeBytes: r.size_bytes,
    durationSec: r.duration_sec,
    status: r.status as TranscriptStatus,
    provider: r.provider as ProviderName,
    quality: r.quality as QualityMode,
    quotaKey: r.quota_key,
    quotaDay: r.quota_day,
    providerJobId: r.provider_job_id,
    languageCode: r.language_code,
    requestedLanguage: r.requested_language,
    speakersExpected: r.speakers_expected,
    keepAudio: r.keep_audio === 1,
    audioFile: r.audio_file,
    error: r.error_code
      ? {
          code: r.error_code as ErrorCode,
          message: r.error_message ?? '',
          ...(r.error_detail ? { detail: r.error_detail } : {}),
        }
      : null,
    attempts: r.attempts,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    notBefore: r.not_before,
    estimatedTotalSeconds: r.estimated_total_seconds,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    processingSeconds: r.processing_seconds,
    documentVersion: r.document_version,
    speakerCount: r.speaker_count,
    rowCount: r.row_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * All persistence for transcripts. The transcripts table doubles as the job queue:
 * workers claim jobs with an atomic UPDATE and hold a time-limited lease that they renew
 * while working. A job whose lease expires (worker crashed / server restarted) is
 * reclaimed by the next free worker, which resumes from `providerJobId` when it has one.
 * Every worker-side mutation is guarded by `lease_owner = workerId`, so a worker that has
 * lost its lease (or whose job was deleted) cannot overwrite newer state.
 */
export class TranscriptRepository {
  constructor(
    readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ---- reads ---------------------------------------------------------------

  get(id: string): TranscriptRecord | undefined {
    const row = this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM transcripts WHERE id = ?`).get(id) as
      Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Newest first. */
  list(limit = 1000): TranscriptRecord[] {
    const rows = this.db
      .prepare(`SELECT ${RECORD_COLUMNS} FROM transcripts ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toRecord);
  }

  getDocument(id: string): TranscriptDocument | null {
    const row = this.db
      .prepare(`SELECT document_json, document_version FROM transcripts WHERE id = ?`)
      .get(id) as { document_json: string | null; document_version: number } | undefined;
    if (!row?.document_json) return null;
    const body = JSON.parse(row.document_json) as { speakers: Speaker[]; rows: TranscriptRow[] };
    return { version: row.document_version, speakers: body.speakers, rows: body.rows };
  }

  /** 1-based position among queued jobs (oldest first), or null if the job is not queued. */
  queuePosition(id: string): number | null {
    const rec = this.db.prepare(`SELECT status, created_at FROM transcripts WHERE id = ?`).get(id) as
      { status: string; created_at: string } | undefined;
    if (!rec || rec.status !== 'queued') return null;
    const { ahead } = this.db
      .prepare(
        `SELECT COUNT(*) AS ahead FROM transcripts
         WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id < ?))`,
      )
      .get(rec.created_at, rec.created_at, id) as { ahead: number };
    return ahead + 1;
  }

  /** Recent successful jobs for a provider, newest first (for ETA estimation). */
  processingStats(provider: ProviderName, limit = 20): { durationSec: number; processingSeconds: number }[] {
    return this.db
      .prepare(
        `SELECT duration_sec AS durationSec, processing_seconds AS processingSeconds FROM transcripts
         WHERE status = 'done' AND provider = ? AND duration_sec > 0 AND processing_seconds > 0
         ORDER BY completed_at DESC LIMIT ?`,
      )
      .all(provider, limit) as { durationSec: number; processingSeconds: number }[];
  }

  /** Stored audio file names that a transcript still references. */
  referencedAudioFiles(): Set<string> {
    const rows = this.db.prepare(`SELECT audio_file FROM transcripts WHERE audio_file IS NOT NULL`).all() as {
      audio_file: string;
    }[];
    return new Set(rows.map((r) => r.audio_file));
  }

  // ---- user actions --------------------------------------------------------

  create(input: NewTranscriptInput): TranscriptRecord {
    const now = this.iso();
    this.db
      .prepare(
        `INSERT INTO transcripts (
          id, title, original_filename, mime_type, extension, size_bytes, duration_sec, status, provider,
          quality, quota_key, quota_day, requested_language, speakers_expected, keep_audio, audio_file,
          estimated_total_seconds, created_at, updated_at
        ) VALUES (
          @id, @title, @originalFilename, @mimeType, @extension, @sizeBytes, @durationSec, 'queued', @provider,
          @quality, @quotaKey, @quotaDay, @requestedLanguage, @speakersExpected, @keepAudio, @audioFile,
          @estimatedTotalSeconds, @now, @now
        )`,
      )
      .run({
        ...input,
        quality: input.quality ?? 'high',
        quotaKey: input.quotaKey ?? null,
        quotaDay: input.quotaKey ? (input.quotaDay ?? null) : null,
        requestedLanguage: input.requestedLanguage ?? null,
        keepAudio: input.keepAudio ? 1 : 0,
        now,
      });
    return this.get(input.id)!;
  }

  /**
   * Creates the job only if the client still has a use of its quality mode left today
   * (`limit` null = unlimited). Check and insert happen in one transaction, so concurrent
   * uploads can't overshoot the limit. Returns null when the limit is reached.
   */
  createWithQuota(
    input: NewTranscriptInput & { quotaKey: string; quotaDay: string },
    limit: number | null,
  ): TranscriptRecord | null {
    return this.db.transaction(() => {
      const mode = input.quality ?? 'high';
      if (limit != null && this.usage(input.quotaKey, mode, input.quotaDay, limit).used >= limit) return null;
      return this.create(input);
    })();
  }

  /**
   * A client's use of a mode on a day: finished jobs (counter) plus jobs still queued or
   * processing. Failed jobs don't count, so a failure never costs the user a use.
   */
  usage(clientKey: string, mode: QualityMode, day: string, limit: number | null): ModeUsage {
    const counted = this.db
      .prepare(`SELECT count FROM usage_counters WHERE client_key = ? AND day = ? AND mode = ?`)
      .get(clientKey, day, mode) as { count: number } | undefined;
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transcripts WHERE quota_key = ? AND quota_day = ? AND quality = ?
           AND status IN ('queued', 'transcribing', 'separating')`,
      )
      .get(clientKey, day, mode) as { n: number };
    const used = (counted?.count ?? 0) + pending.n;
    return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
  }

  updateTitle(id: string, title: string): TranscriptRecord | undefined {
    this.db
      .prepare(`UPDATE transcripts SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, this.iso(), id);
    return this.get(id);
  }

  /** Deletes the record and returns it (so the caller can remove its audio file). */
  delete(id: string): TranscriptRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    this.db.prepare(`DELETE FROM transcripts WHERE id = ?`).run(id);
    return rec;
  }

  /**
   * Atomically forgets the stored audio file and returns its name (null if there was none).
   * The caller deletes the file afterwards; if that fails, orphan cleanup removes it later.
   */
  takeAudioFile(id: string): string | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT audio_file FROM transcripts WHERE id = ?`).get(id) as
        { audio_file: string | null } | undefined;
      if (!row?.audio_file) return null;
      this.db
        .prepare(`UPDATE transcripts SET audio_file = NULL, updated_at = ? WHERE id = ?`)
        .run(this.iso(), id);
      return row.audio_file;
    })();
  }

  /**
   * User-initiated retry of a failed job whose audio is still stored. Returns undefined if not
   * allowed. `retryWithQuota` with `quota`: a job that counts against a daily limit is re-counted for `quota.day`
   * and refused with "quota" when that day's limit is already used up.
   */
  retry(id: string): TranscriptRecord | undefined {
    const res = this.retryWithQuota(id);
    return res === 'quota' ? undefined : res;
  }

  retryWithQuota(
    id: string,
    quota?: { day: string; limit: number | null },
  ): TranscriptRecord | undefined | 'quota' {
    return this.db.transaction(() => {
      const rec = this.get(id);
      if (!rec || rec.status !== 'error' || !rec.audioFile) return undefined;
      const day = rec.quotaKey && quota ? quota.day : rec.quotaDay;
      if (rec.quotaKey && quota && quota.limit != null) {
        if (this.usage(rec.quotaKey, rec.quality, quota.day, quota.limit).used >= quota.limit) return 'quota';
      }
      this.db
        .prepare(
          `UPDATE transcripts SET status = 'queued', error_code = NULL, error_message = NULL, error_detail = NULL,
             attempts = 0, provider_job_id = NULL, not_before = NULL, started_at = NULL, lease_owner = NULL,
             lease_expires_at = NULL, quota_day = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(day, this.iso(), id);
      return this.get(id);
    })();
  }

  saveDocument(
    id: string,
    baseVersion: number,
    body: { speakers: Speaker[]; rows: TranscriptRow[] },
  ): SaveDocumentResult {
    return this.db.transaction((): SaveDocumentResult => {
      const row = this.db.prepare(`SELECT status, document_version FROM transcripts WHERE id = ?`).get(id) as
        { status: string; document_version: number } | undefined;
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.status !== 'done') return { ok: false, reason: 'not_ready' };
      if (row.document_version !== baseVersion) {
        return { ok: false, reason: 'conflict', document: this.getDocument(id)! };
      }
      const version = row.document_version + 1;
      this.db
        .prepare(
          `UPDATE transcripts SET document_json = ?, document_version = ?, speaker_count = ?, row_count = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify({ speakers: body.speakers, rows: body.rows }),
          version,
          body.speakers.length,
          body.rows.length,
          this.iso(),
          id,
        );
      return { ok: true, document: { version, speakers: body.speakers, rows: body.rows } };
    })();
  }

  // ---- worker / job queue --------------------------------------------------

  /**
   * Claims the oldest runnable job: a queued job whose backoff has elapsed, or an in-progress
   * job whose lease expired. Queued jobs move to "transcribing". Increments `attempts`.
   */
  claimNextJob(workerId: string, leaseMs: number): TranscriptRecord | undefined {
    const now = this.now();
    const row = this.db
      .prepare(
        `UPDATE transcripts SET
           status = CASE WHEN status = 'queued' THEN 'transcribing' ELSE status END,
           started_at = CASE WHEN status = 'queued' OR started_at IS NULL THEN @nowIso ELSE started_at END,
           lease_owner = @workerId,
           lease_expires_at = @leaseUntil,
           attempts = attempts + 1,
           not_before = NULL,
           updated_at = @nowIso
         WHERE id = (
           SELECT id FROM transcripts
           WHERE (status = 'queued' AND (not_before IS NULL OR not_before <= @now))
              OR (status IN ('transcribing', 'separating') AND (lease_expires_at IS NULL OR lease_expires_at < @now))
           ORDER BY created_at, id
           LIMIT 1
         )
         RETURNING ${RECORD_COLUMNS}`,
      )
      .get({ workerId, now, leaseUntil: now + leaseMs, nowIso: this.iso(now) }) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Extends the lease. Returns false if the worker no longer owns the job (deleted or reclaimed). */
  renewLease(id: string, workerId: string, leaseMs: number): boolean {
    const now = this.now();
    const res = this.db
      .prepare(
        `UPDATE transcripts SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?
           AND status IN ('transcribing', 'separating')`,
      )
      .run(now + leaseMs, id, workerId);
    return res.changes === 1;
  }

  setProviderJobId(id: string, workerId: string, providerJobId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE transcripts SET provider_job_id = ?, updated_at = ? WHERE id = ? AND lease_owner = ?`,
        )
        .run(providerJobId, this.iso(), id, workerId).changes === 1
    );
  }

  setEstimate(id: string, estimatedTotalSeconds: number | null): void {
    this.db
      .prepare(`UPDATE transcripts SET estimated_total_seconds = ? WHERE id = ?`)
      .run(estimatedTotalSeconds, id);
  }

  setDuration(id: string, durationSec: number): void {
    this.db.prepare(`UPDATE transcripts SET duration_sec = ? WHERE id = ?`).run(durationSec, id);
  }

  markSeparating(id: string, workerId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE transcripts SET status = 'separating', updated_at = ? WHERE id = ? AND lease_owner = ?
             AND status IN ('transcribing', 'separating')`,
        )
        .run(this.iso(), id, workerId).changes === 1
    );
  }

  completeJob(
    id: string,
    workerId: string,
    result: { speakers: Speaker[]; rows: TranscriptRow[]; languageCode: string | null },
  ): boolean {
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT started_at, quota_key, quota_day, quality FROM transcripts WHERE id = ? AND lease_owner = ?`,
        )
        .get(id, workerId) as
        | { started_at: string | null; quota_key: string | null; quota_day: string | null; quality: string }
        | undefined;
      if (!row) return false;
      if (row.quota_key && row.quota_day) {
        this.db
          .prepare(
            `INSERT INTO usage_counters (client_key, day, mode, count) VALUES (?, ?, ?, 1)
             ON CONFLICT (client_key, day, mode) DO UPDATE SET count = count + 1`,
          )
          .run(row.quota_key, row.quota_day, row.quality);
      }
      const processingSeconds = row.started_at ? (now - Date.parse(row.started_at)) / 1000 : null;
      const res = this.db
        .prepare(
          `UPDATE transcripts SET status = 'done', document_json = ?, document_version = 1, speaker_count = ?,
             row_count = ?, language_code = ?, processing_seconds = ?, completed_at = ?, error_code = NULL,
             error_message = NULL, error_detail = NULL, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?
           WHERE id = ? AND lease_owner = ?`,
        )
        .run(
          JSON.stringify({ speakers: result.speakers, rows: result.rows }),
          result.speakers.length,
          result.rows.length,
          result.languageCode,
          processingSeconds,
          this.iso(now),
          this.iso(now),
          id,
          workerId,
        );
      return res.changes === 1;
    })();
  }

  /** Terminal failure. Pass workerId=null to fail regardless of lease (e.g. during startup checks). */
  failJob(id: string, workerId: string | null, error: TranscriptError): boolean {
    const res = this.db
      .prepare(
        `UPDATE transcripts SET status = 'error', error_code = ?, error_message = ?, error_detail = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND (? IS NULL OR lease_owner = ?)`,
      )
      .run(error.code, error.message, error.detail ?? null, this.iso(), id, workerId, workerId);
    return res.changes === 1;
  }

  /**
   * Puts a job back in the queue after a transient failure, to be retried after `delayMs`.
   * Keep the provider job id when the provider-side job may still be valid (e.g. a network
   * error while polling) so the retry resumes instead of re-uploading. `refundAttempt` gives back
   * the attempt this claim used (for interruptions that aren't failures, such as a shutdown).
   */
  requeue(
    id: string,
    workerId: string,
    delayMs: number,
    opts: { keepProviderJobId: boolean; refundAttempt?: boolean },
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE transcripts SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, not_before = ?,
           provider_job_id = CASE WHEN ? THEN provider_job_id ELSE NULL END,
           attempts = CASE WHEN ? THEN MAX(attempts - 1, 0) ELSE attempts END, updated_at = ?
         WHERE id = ? AND lease_owner = ?`,
      )
      .run(
        this.now() + delayMs,
        opts.keepProviderJobId ? 1 : 0,
        opts.refundAttempt ? 1 : 0,
        this.iso(),
        id,
        workerId,
      );
    return res.changes === 1;
  }
}
