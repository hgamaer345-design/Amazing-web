import { ApiError } from '../apiError';
import * as demo from './demoApi';

function wavFile(name: string, size = 64): File {
  const bytes = new Uint8Array(size);
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  bytes.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  return new File([bytes], name, { type: 'audio/wav' });
}

async function upload(name: string, opts: Partial<demo.DemoUploadOptions> = {}) {
  const progress: number[] = [];
  const handle = demo.uploadTranscript(
    wavFile(name),
    { speakersExpected: null, keepAudio: false, clientDurationSec: 30, ...opts },
    (p) => progress.push(p.loaded / p.total),
  );
  await vi.advanceTimersByTimeAsync(3_500);
  return { summary: await handle.promise, progress };
}

describe('demo API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => 'blob:demo');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('simulates upload, processing stages and a finished, editable transcript', async () => {
    const { summary, progress } = await upload('Team call.wav', { speakersExpected: 3 });
    expect(progress.at(-1)).toBe(1);
    expect(summary).toMatchObject({ title: 'Team call', status: 'queued', provider: 'mock' });

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await demo.getTranscript(summary.id)).status).toBe('transcribing');
    await vi.advanceTimersByTimeAsync(20_000);

    const done = await demo.getTranscript(summary.id);
    expect(done.status).toBe('done');
    expect(done.audioAvailable).toBe(false); // not kept -> deleted after processing
    expect(done.document!.speakers.length).toBe(3);
    expect(done.document!.rows.length).toBeGreaterThan(3);

    const doc = done.document!;
    const renamed = doc.speakers.map((s, i) => (i === 0 ? { ...s, name: 'Interviewer' } : s));
    const saved = await demo.saveDocument(summary.id, { baseVersion: doc.version, speakers: renamed, rows: doc.rows });
    expect(saved.version).toBe(doc.version + 1);
    await expect(
      demo.saveDocument(summary.id, { baseVersion: doc.version, speakers: doc.speakers, rows: doc.rows }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    expect((await demo.listTranscripts()).map((t) => t.id)).toContain(summary.id);
    await demo.deleteTranscript(summary.id);
    await expect(demo.getTranscript(summary.id)).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps audio when asked and reports "no speech" from the file-name trigger', async () => {
    const { summary } = await upload('nospeech.wav', { keepAudio: true });
    await vi.advanceTimersByTimeAsync(20_000);
    const failed = await demo.getTranscript(summary.id);
    expect(failed.status).toBe('error');
    expect(failed.error?.code).toBe('NO_SPEECH');
    expect(failed.audioAvailable).toBe(true);
    expect(demo.audioUrl(summary.id)).toBe('blob:demo');
    expect((await demo.retryTranscript(summary.id)).status).toBe('queued');
  });

  it('allows 3 Ultra High transcriptions per day; failures do not use one up', async () => {
    localStorage.clear();
    vi.setSystemTime(new Date('2026-10-25T10:00:00Z'));
    expect((await demo.getUsage()).modes.ultra).toEqual({ used: 0, limit: 3, remaining: 3 });

    const failed = await upload('fail.wav', { quality: 'ultra' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await demo.getTranscript(failed.summary.id)).status).toBe('error');
    expect((await demo.getUsage()).modes.ultra.used).toBe(0);

    const ok = await upload('a.wav', { quality: 'ultra' });
    expect(ok.summary.quality).toBe('ultra');
    expect((await demo.getUsage()).modes.ultra.used).toBe(1); // still processing counts
    await upload('b.wav', { quality: 'ultra' });
    await upload('c.wav', { quality: 'ultra' });
    await vi.advanceTimersByTimeAsync(30_000);
    await demo.listTranscripts(); // settles finished jobs
    const usage = await demo.getUsage();
    expect(usage.modes.ultra).toEqual({ used: 3, limit: 3, remaining: 0 });
    expect(usage.resetsAt).toBe('2026-10-26T00:00:00.000Z');

    const refused = demo.uploadTranscript(
      wavFile('d.wav'),
      { speakersExpected: null, keepAudio: false, clientDurationSec: 30, quality: 'ultra' },
      () => {},
    );
    await expect(refused.promise).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
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
    await vi.advanceTimersByTimeAsync(200);
    handle.abort();
    await expect(handle.promise).rejects.toMatchObject({ code: 'UPLOAD_ABORTED' });
  });
});
