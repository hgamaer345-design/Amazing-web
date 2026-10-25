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
    expect(repo.saveDocument('missing', 1, { speakers, rows: [] })).toEqual({ ok: false, reason: 'not_found' });
  });
});
