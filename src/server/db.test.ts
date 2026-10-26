import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, TranscriptRepository, type NewTranscriptInput } from './db';

function input(id: string, overrides: Partial<NewTranscriptInput> = {}): NewTranscriptInput {
  return {
    id,
    title: id,
    originalFilename: `${id}.mp3`,
    mimeType: 'audio/mpeg',
    extension: 'mp3',
    sizeBytes: 1000,
    durationSec: 60,
    provider: 'mock',
    speakersExpected: null,
    keepAudio: false,
    audioFile: `${id}.mp3`,
    estimatedTotalSeconds: 10,
    ...overrides,
  };
}

function setup() {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const clock = { advance: (ms: number) => (now += ms) };
  const repo = new TranscriptRepository(openDatabase(':memory:'), () => now);
  return { repo, clock };
}

describe('TranscriptRepository', () => {
  it('creates, lists newest first, and deletes', () => {
    const { repo, clock } = setup();
    repo.create(input('a'));
    clock.advance(1000);
    repo.create(input('b'));
    expect(repo.list().map((r) => r.id)).toEqual(['b', 'a']);
    expect(repo.get('a')).toMatchObject({ status: 'queued', keepAudio: false, audioFile: 'a.mp3' });
    expect(repo.delete('a')?.id).toBe('a');
    expect(repo.get('a')).toBeUndefined();
  });

  it('claims jobs oldest first, one worker at a time', () => {
    const { repo, clock } = setup();
    repo.create(input('a'));
    clock.advance(10);
    repo.create(input('b'));
    expect(repo.queuePosition('b')).toBe(2);
    const first = repo.claimNextJob('w1', 60_000);
    expect(first).toMatchObject({ id: 'a', status: 'transcribing', attempts: 1, leaseOwner: 'w1' });
    const second = repo.claimNextJob('w2', 60_000);
    expect(second?.id).toBe('b');
    expect(repo.claimNextJob('w3', 60_000)).toBeUndefined();
  });

  it('reclaims jobs whose lease expired and guards writes by lease owner', () => {
    const { repo, clock } = setup();
    repo.create(input('a'));
    repo.claimNextJob('w1', 1000);
    expect(repo.setProviderJobId('a', 'w1', 'prov-1')).toBe(true);
    clock.advance(500);
    expect(repo.renewLease('a', 'w1', 1000)).toBe(true);
    expect(repo.claimNextJob('w2', 1000)).toBeUndefined();
    clock.advance(1500);
    const reclaimed = repo.claimNextJob('w2', 1000);
    expect(reclaimed).toMatchObject({ id: 'a', providerJobId: 'prov-1', attempts: 2, leaseOwner: 'w2' });
    // The old worker lost its lease and can no longer write.
    expect(repo.renewLease('a', 'w1', 1000)).toBe(false);
    expect(repo.completeJob('a', 'w1', { speakers: [], rows: [], languageCode: null })).toBe(false);
    expect(repo.markSeparating('a', 'w2')).toBe(true);
    expect(
      repo.completeJob('a', 'w2', {
        speakers: [{ id: 'spk_1', name: 'Speaker 1', colorIndex: 0 }],
        rows: [{ id: 'row_1', speakerId: 'spk_1', startMs: 0, endMs: 1000, text: 'Hi' }],
        languageCode: 'en',
      }),
    ).toBe(true);
    const done = repo.get('a')!;
    expect(done).toMatchObject({ status: 'done', languageCode: 'en', speakerCount: 1, rowCount: 1 });
    expect(done.processingSeconds).toBeCloseTo(2, 5);
    expect(repo.getDocument('a')).toMatchObject({ version: 1, rows: [{ text: 'Hi' }] });
  });

  it('requeues with backoff and optionally keeps the provider job id', () => {
    const { repo, clock } = setup();
    repo.create(input('a'));
    repo.claimNextJob('w1', 60_000);
    repo.setProviderJobId('a', 'w1', 'prov-1');
    expect(repo.requeue('a', 'w1', 5000, { keepProviderJobId: true })).toBe(true);
    expect(repo.claimNextJob('w1', 60_000)).toBeUndefined();
    clock.advance(5000);
    expect(repo.claimNextJob('w1', 60_000)).toMatchObject({ id: 'a', providerJobId: 'prov-1', attempts: 2 });
    expect(repo.requeue('a', 'w1', 0, { keepProviderJobId: false })).toBe(true);
    expect(repo.get('a')?.providerJobId).toBeNull();
  });

  it('fails jobs, and allows retry only while audio is stored', () => {
    const { repo } = setup();
    repo.create(input('a'));
    repo.claimNextJob('w1', 60_000);
    expect(repo.failJob('a', 'w1', { code: 'NO_SPEECH', message: 'No speech' })).toBe(true);
    expect(repo.get('a')?.error).toEqual({ code: 'NO_SPEECH', message: 'No speech' });
    expect(repo.retry('a')).toMatchObject({ status: 'queued', error: null, attempts: 0 });
    repo.claimNextJob('w1', 60_000);
    repo.failJob('a', null, { code: 'TRANSCRIPTION_FAILED', message: 'x', detail: 'y' });
    expect(repo.takeAudioFile('a')).toBe('a.mp3');
    expect(repo.takeAudioFile('a')).toBeNull();
    expect(repo.retry('a')).toBeUndefined();
    expect(repo.referencedAudioFiles().size).toBe(0);
  });

  it('enforces daily quality limits: pending and finished jobs count, failures and deletions do not refund', () => {
    const { repo, clock } = setup();
    const day = '2026-01-01';
    const ultra = (id: string) => ({
      ...input(id),
      quality: 'ultra' as const,
      quotaKey: 'client-1',
      quotaDay: day,
    });
    expect(repo.usage('client-1', 'ultra', day, 2)).toEqual({ used: 0, limit: 2, remaining: 2 });

    expect(repo.createWithQuota(ultra('a'), 2)?.quality).toBe('ultra');
    expect(repo.createWithQuota(ultra('b'), 2)).not.toBeNull();
    expect(repo.createWithQuota(ultra('c'), 2)).toBeNull(); // two pending already
    expect(repo.usage('client-1', 'ultra', day, 2).remaining).toBe(0);
    // Other clients and other modes are unaffected.
    expect(repo.createWithQuota({ ...ultra('d'), quotaKey: 'client-2' }, 2)).not.toBeNull();
    expect(repo.createWithQuota({ ...ultra('e'), quality: 'high' }, null)?.quality).toBe('high');

    // a fails (gives its use back); b completes (counted for good, even after deletion).
    repo.claimNextJob('w1', 60_000);
    repo.failJob('a', 'w1', { code: 'TRANSCRIPTION_FAILED', message: 'x' });
    clock.advance(1);
    repo.claimNextJob('w1', 60_000);
    repo.completeJob('b', 'w1', { speakers: [], rows: [], languageCode: null });
    repo.delete('b');
    expect(repo.usage('client-1', 'ultra', day, 2)).toEqual({ used: 1, limit: 2, remaining: 1 });

    // Retrying the failed job is counted again, against the retry day.
    expect(repo.retryWithQuota('a', { day: '2026-01-02', limit: 2 })).toMatchObject({ status: 'queued' });
    expect(repo.get('a')?.quotaDay).toBe('2026-01-02');
    expect(repo.usage('client-1', 'ultra', day, 2).used).toBe(1);
    expect(repo.usage('client-1', 'ultra', '2026-01-02', 2).used).toBe(1);
  });

  it('refuses a retry when the limit for the retry day is used up', () => {
    const { repo } = setup();
    const day = '2026-01-01';
    repo.createWithQuota({ ...input('a'), quality: 'ultra', quotaKey: 'k', quotaDay: day }, 1);
    repo.claimNextJob('w1', 60_000);
    repo.failJob('a', 'w1', { code: 'TRANSCRIPTION_FAILED', message: 'x' });
    repo.createWithQuota({ ...input('b'), quality: 'ultra', quotaKey: 'k', quotaDay: day }, 1);
    expect(repo.retryWithQuota('a', { day, limit: 1 })).toBe('quota');
    expect(repo.get('a')?.status).toBe('error');
  });

  it('saves documents with optimistic concurrency', () => {
    const { repo } = setup();
    repo.create(input('a'));
    expect(repo.saveDocument('a', 0, { speakers: [], rows: [] })).toEqual({ ok: false, reason: 'not_ready' });
    repo.claimNextJob('w1', 60_000);
    const speakers = [{ id: 'spk_1', name: 'Speaker 1', colorIndex: 0 }];
    repo.completeJob('a', 'w1', { speakers, rows: [], languageCode: null });
    const saved = repo.saveDocument('a', 1, { speakers: [{ ...speakers[0]!, name: 'Host' }], rows: [] });
    expect(saved).toMatchObject({ ok: true, document: { version: 2 } });
    const stale = repo.saveDocument('a', 1, { speakers, rows: [] });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', document: { version: 2 } });
    expect(repo.saveDocument('missing', 1, { speakers, rows: [] })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('stores the language chosen at upload (none = detect)', () => {
    const { repo } = setup();
    expect(repo.create(input('a', { requestedLanguage: 'ja' })).requestedLanguage).toBe('ja');
    expect(repo.create(input('b')).requestedLanguage).toBeNull();
    expect(repo.get('a')?.requestedLanguage).toBe('ja');
    expect(repo.get('b')?.requestedLanguage).toBeNull();
  });
});

describe('database migrations', () => {
  it('adds the requested language to a database created before it existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-db-'));
    const file = path.join(dir, 'transcripts.db');
    try {
      // Recreate the previous schema (version 2): no requested_language column.
      const old = openDatabase(file);
      old.exec('ALTER TABLE transcripts DROP COLUMN requested_language');
      old.pragma('user_version = 2');
      old
        .prepare(
          `INSERT INTO transcripts (id, title, original_filename, mime_type, extension, size_bytes, status,
             provider, created_at, updated_at)
           VALUES ('old', 'Old', 'old.mp3', 'audio/mpeg', 'mp3', 10, 'done', 'mock', '2025-01-01', '2025-01-01')`,
        )
        .run();
      old.close();

      const db = openDatabase(file);
      expect(db.pragma('user_version', { simple: true })).toBe(3);
      const repo = new TranscriptRepository(db);
      expect(repo.get('old')).toMatchObject({ id: 'old', status: 'done', requestedLanguage: null });
      expect(repo.create(input('new', { requestedLanguage: 'fr' })).requestedLanguage).toBe('fr');
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
