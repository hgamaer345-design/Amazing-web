import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestContext, fakeProvider, waitFor, type TestContext } from '../../tests/server/context';
import { makeWav } from '../../tests/server/wav';
import { parseClientDuration, parseKeepAudio, parseSpeakersExpected, titleFromFilename } from './upload';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function upload(app = ctx.app) {
  return request(app).post('/api/transcripts');
}

function expectNothingStored() {
  expect(ctx.uploadedFiles()).toEqual([]);
  expect(ctx.repo.list()).toEqual([]);
  expect(ctx.worker.kick).not.toHaveBeenCalled();
}

describe('POST /api/transcripts', () => {
  beforeEach(() => {
    ctx = createTestContext();
  });

  it('stores the file, creates a queued transcript and wakes the worker', async () => {
    const wav = makeWav({ seconds: 2.5 });
    const res = await upload()
      .field('speakersExpected', '3')
      .field('keepAudio', 'true')
      .field('clientDurationSec', '99')
      .attach('file', wav, { filename: 'Team call.final.WAV', contentType: 'audio/x-wav' });

    expect(res.status).toBe(201);
    const t = res.body.transcript;
    expect(t).toMatchObject({
      title: 'Team call.final',
      originalFilename: 'Team call.final.WAV',
      mimeType: 'audio/x-wav',
      sizeBytes: wav.length,
      status: 'queued',
      provider: 'mock',
      speakersExpected: 3,
      keepAudio: true,
      audioAvailable: true,
      error: null,
    });
    expect(t.durationSec).toBeCloseTo(2.5, 3);
    expect(res.headers.location).toBe(`/api/transcripts/${t.id}`);

    const rec = ctx.repo.get(t.id)!;
    expect(rec.extension).toBe('wav');
    expect(rec.estimatedTotalSeconds).toBeGreaterThan(0);
    expect(ctx.uploadedFiles()).toEqual([rec.audioFile]);
    expect(rec.audioFile).toMatch(/^[0-9a-f-]{36}\.wav$/);
    await expect(ctx.storage.size(rec.audioFile!)).resolves.toBe(wav.length);
    expect(ctx.worker.kick).toHaveBeenCalledTimes(1);
  });

  it('applies defaults and keeps non-ASCII file names intact', async () => {
    const res = await upload().attach('file', makeWav({ seconds: 1 }), {
      filename: 'Entrevista café – 日本.wav',
      contentType: 'application/octet-stream',
    });
    expect(res.status).toBe(201);
    expect(res.body.transcript).toMatchObject({
      title: 'Entrevista café – 日本',
      originalFilename: 'Entrevista café – 日本.wav',
      // Not an audio type, so the default for the extension is stored instead.
      mimeType: 'audio/wav',
      speakersExpected: null,
      keepAudio: false,
    });
  });

  it('accepts a known container behind a different accepted extension', async () => {
    const res = await upload().attach('file', makeWav({ seconds: 3 }), 'actually-a-wav.mp3');
    expect(res.status).toBe(201);
    expect(res.body.transcript.durationSec).toBeCloseTo(3, 3);
    expect(ctx.repo.get(res.body.transcript.id)?.extension).toBe('mp3');
  });

  it('accepts fields sent after the file', async () => {
    const res = await upload().attach('file', makeWav({ seconds: 1 }), 'late.wav').field('keepAudio', 'true');
    expect(res.status).toBe(201);
    expect(res.body.transcript.keepAudio).toBe(true);
  });

  it('falls back to the browser-measured duration when the file has none', async () => {
    const res = await upload().field('clientDurationSec', '42.5').attach('file', makeWav({ seconds: 0 }), 'rec.wav');
    expect(res.status).toBe(201);
    expect(res.body.transcript.durationSec).toBe(42.5);
  });

  it('ignores an unusable browser-measured duration', async () => {
    const res = await upload().field('clientDurationSec', 'Infinity').attach('file', makeWav({ seconds: 0 }), 'r.wav');
    expect(res.status).toBe(201);
    expect(res.body.transcript.durationSec).toBeNull();
  });

  it('does not record a speaker count the provider cannot use', async () => {
    ctx.cleanup();
    ctx = createTestContext({ provider: fakeProvider({ name: 'deepgram', supportsSpeakerCount: false }) });
    const res = await upload().field('speakersExpected', '2').attach('file', makeWav({ seconds: 1 }), 'a.wav');
    expect(res.status).toBe(201);
    expect(res.body.transcript).toMatchObject({ speakersExpected: null, provider: 'deepgram' });
  });

  it('rejects unsupported extensions without storing anything', async () => {
    const res = await upload().attach('file', makeWav({ seconds: 1 }), 'notes.txt');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
    expectNothingStored();
  });

  it('rejects files without an extension', async () => {
    const res = await upload().attach('file', makeWav({ seconds: 1 }), 'recording');
    expect(res.status).toBe(415);
    expectNothingStored();
  });

  it('rejects content that is not audio even with an audio extension', async () => {
    const res = await upload().attach('file', Buffer.from('This is a plain text file pretending to be audio.'), 'talk.mp3');
    expect(res.status).toBe(415);
    expect(res.body.error).toMatchObject({ code: 'UNSUPPORTED_FILE' });
    expect(res.body.error.detail).toContain('talk.mp3');
    expectNothingStored();
  });

  it('rejects tiny files that cannot be identified', async () => {
    const res = await upload().attach('file', Buffer.from('RIFF'), 'tiny.wav');
    expect(res.status).toBe(415);
    expectNothingStored();
  });

  it('rejects audio-looking files that cannot be parsed (422)', async () => {
    const garbage = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WAVE', 'latin1'), Buffer.alloc(64, 0xab)]);
    const res = await upload().attach('file', garbage, 'broken.wav');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNREADABLE_AUDIO');
    expectNothingStored();
  });

  it('rejects empty files', async () => {
    const res = await upload().attach('file', Buffer.alloc(0), 'empty.wav');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMPTY_FILE');
    expectNothingStored();
  });

  it('requires a file part', async () => {
    const res = await upload().field('keepAudio', 'true');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
    expectNothingStored();
  });

  it('requires a multipart body', async () => {
    const res = await upload().send({ file: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
  });

  it('requires the file under the "file" field', async () => {
    const res = await upload().attach('audio', makeWav({ seconds: 1 }), 'a.wav');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expectNothingStored();
  });

  it('accepts only one file', async () => {
    const res = await upload()
      .attach('file', makeWav({ seconds: 1 }), 'a.wav')
      .attach('file', makeWav({ seconds: 1 }), 'b.wav');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expectNothingStored();
  });

  it.each(['0', '11', '-1', '2.5', 'abc', '1e1'])('rejects speakersExpected=%s', async (value) => {
    const res = await upload().field('speakersExpected', value).attach('file', makeWav({ seconds: 1 }), 'a.wav');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.message).toContain('1 to 10');
    expectNothingStored();
  });

  it('rejects an invalid keepAudio value', async () => {
    const res = await upload().field('keepAudio', 'maybe').attach('file', makeWav({ seconds: 1 }), 'a.wav');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expectNothingStored();
  });

  it('rejects oversized form fields', async () => {
    const res = await upload().field('keepAudio', 'x'.repeat(5000)).attach('file', makeWav({ seconds: 1 }), 'a.wav');
    expect(res.status).toBe(400);
    expectNothingStored();
  });

  it('answers 503 when no provider is configured', async () => {
    ctx.cleanup();
    ctx = createTestContext({ env: { TRANSCRIPTION_PROVIDER: '' }, provider: null });
    const res = await upload().attach('file', makeWav({ seconds: 1 }), 'a.wav');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expectNothingStored();
  });
});

describe('upload size limit', () => {
  const MAX = 20_000;
  beforeEach(() => {
    ctx = createTestContext({ configure: (config) => (config.maxUploadBytes = MAX) });
  });

  it('accepts a file of exactly the maximum size', async () => {
    const wav = makeWav({ seconds: (MAX - 44) / 2 / 8000 });
    expect(wav.length).toBe(MAX);
    const res = await upload().attach('file', wav, 'exact.wav');
    expect(res.status).toBe(201);
    expect(res.body.transcript.sizeBytes).toBe(MAX);
  });

  it('rejects early from Content-Length', async () => {
    const res = await upload().attach('file', makeWav({ seconds: 10 }), 'big.wav'); // ~160 KB
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'FILE_TOO_LARGE', message: expect.stringContaining('19.5 KB') });
    expectNothingStored();
  });

  it('enforces the limit while streaming and removes the partial file', async () => {
    // Small enough to pass the Content-Length pre-check (which allows for multipart overhead).
    const res = await upload().attach('file', makeWav({ seconds: 2 }), 'big.wav'); // ~32 KB
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expectNothingStored();
  });
});

describe('uploads over a raw connection', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    ctx = createTestContext({ configure: (config) => (config.maxUploadBytes = 1024 * 1024) });
    server = http.createServer(ctx.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const boundary = '----speaker-test-boundary';
  const fileHead = (name: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    'Content-Type: audio/wav\r\n\r\n';

  function openUpload(contentLength: number) {
    return http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/transcripts',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
    });
  }

  it('rejects a too-large declared Content-Length before any body is sent', async () => {
    const req = openUpload(10 * 1024 * 1024 * 1024);
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });
    req.flushHeaders();
    const { status, body } = await response;
    req.destroy();
    expect(status).toBe(413);
    expect(JSON.parse(body).error.code).toBe('FILE_TOO_LARGE');
    expectNothingStored();
  });

  it('removes the partial file when the client disconnects mid-upload', async () => {
    const wav = makeWav({ seconds: 4 });
    const head = fileHead('cut-off.wav');
    const req = openUpload(head.length + wav.length + 100);
    req.on('error', () => undefined);
    req.write(head);
    req.write(wav.subarray(0, 8192));
    await waitFor(() => ctx.uploadedFiles().some((f) => f.endsWith('.wav.part')));
    req.destroy();
    await waitFor(() => ctx.uploadedFiles().length === 0);
    expect(ctx.repo.list()).toEqual([]);
  });
});

describe('field parsing', () => {
  it('parses speakersExpected', () => {
    expect(parseSpeakersExpected('', 10)).toBeNull();
    expect(parseSpeakersExpected(' 4 ', 10)).toBe(4);
    expect(parseSpeakersExpected('10', 10)).toBe(10);
    expect(() => parseSpeakersExpected('11', 10)).toThrow(/1 to 10/);
  });

  it('parses keepAudio', () => {
    expect(parseKeepAudio('true')).toBe(true);
    expect(parseKeepAudio('FALSE')).toBe(false);
    expect(parseKeepAudio('')).toBe(false);
    expect(() => parseKeepAudio('yes')).toThrow();
  });

  it('parses clientDurationSec leniently', () => {
    expect(parseClientDuration('12.25')).toBe(12.25);
    expect(parseClientDuration('0')).toBeNull();
    expect(parseClientDuration('-3')).toBeNull();
    expect(parseClientDuration('NaN')).toBeNull();
    expect(parseClientDuration('')).toBeNull();
  });

  it('derives titles from file names', () => {
    expect(titleFromFilename('meeting.mp3')).toBe('meeting');
    expect(titleFromFilename('  spaced  .wav')).toBe('spaced');
    expect(titleFromFilename('.mp3')).toBe('Untitled recording');
    expect(titleFromFilename(`${'a'.repeat(300)}.mp3`)).toHaveLength(200);
    expect(titleFromFilename('line\nbreak.ogg')).toBe('line break');
  });
});
