import request from 'supertest';
import { createTestContext, type TestContext } from '../../tests/server/context';
import { makeWav } from '../../tests/server/wav';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function uploadWith(quality?: string, opts: { query?: boolean; ip?: string } = {}) {
  const path = quality && opts.query !== false ? `/api/transcripts?quality=${quality}` : '/api/transcripts';
  let req = request(ctx.app).post(path);
  if (opts.ip) req = req.set('X-Forwarded-For', opts.ip);
  if (quality) req = req.field('quality', quality);
  return req.attach('file', makeWav({ seconds: 1 }), { filename: 'call.wav', contentType: 'audio/wav' });
}

describe('quality modes', () => {
  beforeEach(() => {
    ctx = createTestContext({ env: { ULTRA_DAILY_LIMIT: '2', TRUST_PROXY: 'true' } });
  });

  it('lists the modes and their daily limits in /api/config', async () => {
    const res = await request(ctx.app).get('/api/config');
    expect(res.body.defaultQuality).toBe('high');
    expect(
      res.body.qualityModes.map((m: { id: string; dailyLimit: number | null }) => [m.id, m.dailyLimit]),
    ).toEqual([
      ['standard', null],
      ['high', null],
      ['ultra', 2],
    ]);
  });

  it('records the chosen quality (default High) and rejects unknown values', async () => {
    expect((await uploadWith()).body.transcript.quality).toBe('high');
    const standard = await uploadWith('standard');
    expect(standard.status).toBe(201);
    expect(ctx.repo.get(standard.body.transcript.id)?.quality).toBe('standard');
    const bad = await uploadWith('extreme', { query: false });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_INPUT');
  });

  it('allows the configured number of Ultra High uses per visitor per day', async () => {
    expect((await request(ctx.app).get('/api/usage')).body.modes.ultra).toEqual({
      used: 0,
      limit: 2,
      remaining: 2,
    });
    expect((await uploadWith('ultra')).status).toBe(201);
    expect((await uploadWith('ultra')).status).toBe(201);

    // Over the limit: refused before the file is stored, with or without the query hint.
    const refused = await uploadWith('ultra');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('QUOTA_EXCEEDED');
    const refusedLate = await uploadWith('ultra', { query: false });
    expect(refusedLate.status).toBe(429);
    expect(ctx.uploadedFiles()).toHaveLength(2);

    const usage = (await request(ctx.app).get('/api/usage')).body;
    expect(usage.modes.ultra).toEqual({ used: 2, limit: 2, remaining: 0 });
    expect(usage.modes.high).toEqual({ used: 0, limit: null, remaining: null });
    expect(usage.resetsAt).toBe('2026-03-02T00:00:00.000Z');

    // Other modes stay unlimited; other visitors have their own allowance.
    expect((await uploadWith('high')).status).toBe(201);
    expect((await uploadWith('ultra', { ip: '203.0.113.9' })).status).toBe(201);

    // The next UTC day starts fresh.
    ctx.clock.advance(24 * 60 * 60 * 1000);
    expect((await request(ctx.app).get('/api/usage')).body.modes.ultra.used).toBe(0);
    expect((await uploadWith('ultra')).status).toBe(201);
  });

  it('checks the allowance again when a failed Ultra High job is retried', async () => {
    const first = (await uploadWith('ultra')).body.transcript.id;
    ctx.repo.claimNextJob('w', 60_000);
    ctx.repo.failJob(first, 'w', { code: 'TRANSCRIPTION_FAILED', message: 'x' });
    await uploadWith('ultra');
    await uploadWith('ultra');
    const retry = await request(ctx.app).post(`/api/transcripts/${first}/retry`);
    expect(retry.status).toBe(429);
    expect(retry.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(ctx.repo.get(first)?.status).toBe('error');
  });
});
