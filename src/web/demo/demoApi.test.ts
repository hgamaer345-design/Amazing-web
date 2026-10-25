import { ApiError } from '../apiError';
import * as demo from './demoApi';
import type { SpeechEngine } from './speech/engine';
import type { SpeechJobOptions, SpeechProgress, SpeechResult } from './speech/protocol';

function wavFile(name: string, size = 64): File {
  const bytes = new Uint8Array(size);
  bytes.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [...'WAVE'].map((c) => c.charCodeAt(0)),
    8,
  );
  return new File([bytes], name, { type: 'audio/wav' });
}

interface FakeJob {
  audio: Blob;
  options: SpeechJobOptions;
  progress(p: SpeechProgress): void;
  resolve(result: SpeechResult): void;
  reject(err: unknown): void;
  cancelled: boolean;
}

/** Engine whose jobs the tests finish by hand. */
const jobs: FakeJob[] = [];
const fakeEngine: SpeechEngine = {
  run(audio, options, onProgress) {
    let job!: FakeJob;
    const promise = new Promise<SpeechResult>((resolve, reject) => {
      job = { audio, options, progress: onProgress, resolve, reject, cancelled: false };
    });
    jobs.push(job);
    return {
      promise,
      cancel() {
        job.cancelled = true;
        job.reject(new Error('Cancelled.'));
      },
    };
  },
};

const RESULT: SpeechResult = {
  segments: [
    { speaker: 'S0', startMs: 0, endMs: 2_000, text: 'Hello and welcome.' },
    { speaker: 'S0', startMs: 2_000, endMs: 4_000, text: 'Thanks for coming.' },
    { speaker: 'S1', startMs: 4_500, endMs: 6_000, text: 'Happy to be here.' },
    { speaker: 'S0', startMs: 6_500, endMs: 8_000, text: 'Let us begin.' },
  ],
  languageCode: 'en',
  durationSec: 8.2,
};

async function nextJob(count: number): Promise<FakeJob> {
  await vi.waitFor(() => expect(jobs.length).toBeGreaterThanOrEqual(count));
  return jobs[count - 1]!;
}

async function upload(name: string, opts: Partial<demo.DemoUploadOptions> = {}) {
  const progress: number[] = [];
  const handle = demo.uploadTranscript(
    wavFile(name),
    { speakersExpected: null, keepAudio: false, clientDurationSec: 30, ...opts },
    (p) => progress.push(p.loaded / p.total),
  );
  return { summary: await handle.promise, progress };
}

async function settled(id: string) {
  await vi.waitFor(async () => expect(['done', 'error']).toContain((await demo.getTranscript(id)).status));
  return demo.getTranscript(id);
}

describe('demo API (in-browser transcription)', () => {
  beforeAll(() => demo.setSpeechEngineForTests(fakeEngine));
  afterAll(() => demo.setSpeechEngineForTests(null));
  beforeEach(() => {
    localStorage.clear();
    URL.createObjectURL = vi.fn(() => 'blob:demo');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const t of await demo.listTranscripts()) await demo.deleteTranscript(t.id);
    jobs.length = 0;
  });

  it('transcribes on this device, reporting live progress, into an editable document', async () => {
    const { summary, progress } = await upload('Team call.wav', { speakersExpected: 2 });
    expect(progress.at(-1)).toBe(1);
    expect(summary).toMatchObject({ title: 'Team call', status: 'queued', quality: 'high' });

    const job = await nextJob(1);
    expect(job.options).toEqual({ quality: 'high', speakersExpected: 2 });
    job.progress({ stage: 'speakers', message: 'Finding the speakers… 40%', fraction: 0.1 });
    const running = await demo.getTranscript(summary.id);
    expect(running.status).toBe('transcribing');
    expect(running.progress).toMatchObject({ message: 'Finding the speakers… 40%', fraction: 0.1 });

    job.resolve(RESULT);
    const done = await settled(summary.id);
    expect(done).toMatchObject({
      status: 'done',
      languageCode: 'en',
      audioAvailable: false,
      durationSec: 30,
    });
    const doc = done.document!;
    expect(doc.speakers.map((s) => s.name)).toEqual(['Speaker 1', 'Speaker 2']);
    // Consecutive sentences from the same speaker share a row.
    expect(doc.rows.map((r) => [r.speakerId, r.text])).toEqual([
      ['spk_1', 'Hello and welcome. Thanks for coming.'],
      ['spk_2', 'Happy to be here.'],
      ['spk_1', 'Let us begin.'],
    ]);

    const renamed = doc.speakers.map((s, i) => (i === 0 ? { ...s, name: 'Interviewer' } : s));
    const saved = await demo.saveDocument(summary.id, {
      baseVersion: doc.version,
      speakers: renamed,
      rows: doc.rows,
    });
    expect(saved.version).toBe(doc.version + 1);
    await expect(
      demo.saveDocument(summary.id, { baseVersion: doc.version, speakers: doc.speakers, rows: doc.rows }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await demo.deleteTranscript(summary.id);
    await expect(demo.getTranscript(summary.id)).rejects.toBeInstanceOf(ApiError);
  });

  it('processes one file at a time, in upload order', async () => {
    const first = await upload('first.wav');
    const second = await upload('second.wav', { quality: 'standard' });
    const job1 = await nextJob(1);
    expect((await demo.getTranscript(second.summary.id)).progress.queuePosition).toBe(2);
    expect(jobs).toHaveLength(1);

    job1.resolve(RESULT);
    const job2 = await nextJob(2);
    expect(job2.options.quality).toBe('standard');
    job2.resolve(RESULT);
    expect((await settled(first.summary.id)).status).toBe('done');
    expect((await settled(second.summary.id)).status).toBe('done');
  });

  it('keeps the audio after a failure so the file can be retried', async () => {
    const { summary } = await upload('quiet.wav');
    (await nextJob(1)).reject(Object.assign(new Error('No speech was detected.'), { code: 'NO_SPEECH' }));
    const failed = await settled(summary.id);
    expect(failed.error?.code).toBe('NO_SPEECH');
    expect(failed.audioAvailable).toBe(true);
    expect(demo.audioUrl(summary.id)).toBe('blob:demo');

    expect((await demo.retryTranscript(summary.id)).status).toBe('queued');
    (await nextJob(2)).reject(Object.assign(new Error('fetch failed'), { code: 'MODEL_DOWNLOAD' }));
    const offline = await settled(summary.id);
    expect(offline.error).toMatchObject({ code: 'TRANSCRIPTION_FAILED', detail: 'fetch failed' });
    expect(offline.error?.message).toMatch(/couldn’t be downloaded/);

    expect((await demo.retryTranscript(summary.id)).status).toBe('queued');
    (await nextJob(3)).resolve({ ...RESULT, segments: [] });
    expect((await settled(summary.id)).error?.code).toBe('NO_SPEECH');
  });

  it('keeps audio when asked, and stops processing when a transcript is deleted', async () => {
    const kept = await upload('keep.wav', { keepAudio: true, clientDurationSec: null });
    (await nextJob(1)).resolve(RESULT);
    const done = await settled(kept.summary.id);
    expect(done.audioAvailable).toBe(true);
    expect(done.durationSec).toBe(8.2); // from the decoded audio when the browser couldn't tell

    const removed = await upload('remove.wav');
    const job = await nextJob(2);
    await demo.deleteTranscript(removed.summary.id);
    expect(job.cancelled).toBe(true);
  });

  it('allows 3 Ultra High transcriptions per day; failures do not use one up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T10:00:00Z'));
    expect((await demo.getUsage()).modes.ultra).toEqual({ used: 0, limit: 3, remaining: 3 });

    const failed = await upload('fail.wav', { quality: 'ultra' });
    (await nextJob(1)).reject(new Error('boom'));
    expect((await settled(failed.summary.id)).status).toBe('error');
    expect((await demo.getUsage()).modes.ultra.used).toBe(0);

    const a = await upload('a.wav', { quality: 'ultra' });
    expect((await demo.getUsage()).modes.ultra.used).toBe(1); // still processing counts
    await upload('b.wav', { quality: 'ultra' });
    const c = await upload('c.wav', { quality: 'ultra' });
    for (let n = 2; n <= 4; n++) (await nextJob(n)).resolve(RESULT);
    await settled(a.summary.id);
    await settled(c.summary.id);
    const usage = await demo.getUsage();
    expect(usage.modes.ultra).toEqual({ used: 3, limit: 3, remaining: 0 });
    expect(usage.resetsAt).toBe('2026-10-26T00:00:00.000Z');

    const refused = demo.uploadTranscript(
      wavFile('d.wav'),
      { speakersExpected: null, keepAudio: false, clientDurationSec: 30, quality: 'ultra' },
      () => {},
    );
    await expect(refused.promise).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
    await expect(demo.retryTranscript(failed.summary.id)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    // Other modes are unlimited, and the limit resets the next UTC day.
    expect((await upload('e.wav', { quality: 'high' })).summary.quality).toBe('high');
    vi.setSystemTime(new Date('2026-10-26T00:00:01Z'));
    expect((await demo.getUsage()).modes.ultra.remaining).toBe(3);
  });

  it('rejects unsupported files and can be cancelled', async () => {
    const bad = demo.uploadTranscript(
      new File(['hello'], 'notes.txt'),
      { speakersExpected: null, keepAudio: false, clientDurationSec: null },
      () => {},
    );
    await expect(bad.promise).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });

    const fake = demo.uploadTranscript(
      new File(['not really audio'], 'song.mp3'),
      { speakersExpected: null, keepAudio: false, clientDurationSec: null },
      () => {},
    );
    await expect(fake.promise).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });

    const handle = demo.uploadTranscript(
      wavFile('long.wav'),
      { speakersExpected: null, keepAudio: false, clientDurationSec: null },
      () => {},
    );
    handle.abort();
    await expect(handle.promise).rejects.toMatchObject({ code: 'UPLOAD_ABORTED' });
    expect(await demo.listTranscripts()).toEqual([]);
  });
});
