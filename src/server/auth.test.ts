import request from 'supertest';
import { createTestContext, type TestContext } from '../../tests/server/context';
import { parseBasicAuth } from './auth';

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

describe('parseBasicAuth', () => {
  it('decodes user and password (the password may contain colons and non-ASCII)', () => {
    expect(parseBasicAuth(basic('admin', 'pä:ss:wörd'))).toEqual({ user: 'admin', password: 'pä:ss:wörd' });
    expect(parseBasicAuth(`basic  ${Buffer.from('a:').toString('base64')}`)).toEqual({
      user: 'a',
      password: '',
    });
  });

  it('rejects missing and malformed headers', () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('')).toBeNull();
    expect(parseBasicAuth('Bearer abc')).toBeNull();
    expect(parseBasicAuth('Basic')).toBeNull();
    expect(parseBasicAuth('Basic !!!')).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from('no-colon').toString('base64')}`)).toBeNull();
  });
});

describe('basic auth middleware', () => {
  let ctx: TestContext;
  afterEach(() => ctx.cleanup());

  describe('when configured', () => {
    beforeEach(() => {
      ctx = createTestContext({ env: { BASIC_AUTH_USER: 'team', BASIC_AUTH_PASSWORD: 's3cret:ü' } });
    });

    it('challenges requests without credentials', async () => {
      const res = await request(ctx.app).get('/api/transcripts');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="Speaker Transcriber", charset="UTF-8"');
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a wrong user or password', async () => {
      for (const header of [basic('team', 'wrong'), basic('other', 's3cret:ü'), basic('team', 's3cret:ü ')]) {
        const res = await request(ctx.app).get('/api/config').set('Authorization', header);
        expect(res.status).toBe(401);
      }
    });

    it('accepts the right credentials', async () => {
      const res = await request(ctx.app).get('/api/config').set('Authorization', basic('team', 's3cret:ü'));
      expect(res.status).toBe(200);
      expect(res.body.providerConfigured).toBe(true);
    });

    it('protects non-API routes too', async () => {
      expect((await request(ctx.app).get('/')).status).toBe(401);
    });

    it('leaves the health check open', async () => {
      const res = await request(ctx.app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  it('is off when no credentials are configured', async () => {
    ctx = createTestContext();
    const res = await request(ctx.app).get('/api/transcripts');
    expect(res.status).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});
