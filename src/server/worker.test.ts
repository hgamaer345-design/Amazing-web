import { createTestContext, seedTranscript, waitFor, type TestContext } from '../../tests/server/context';
import { createMockProvider } from './providers/mock';
import type { TranscribeRequest } from './providers/types';
import { createWorker } from './worker';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe('worker', () => {
  it('passes the language chosen at upload to the provider', async () => {
    ctx = createTestContext();
    const mock = createMockProvider({ delayMs: 0 });
    const languages: (string | null | undefined)[] = [];
    const provider = {
      ...mock,
      transcribe: (req: TranscribeRequest) => {
        languages.push(req.language);
        return mock.transcribe(req);
      },
    };
    const chosen = seedTranscript(ctx, { requestedLanguage: 'fr' });
    const detected = seedTranscript(ctx);
    const worker = createWorker({
      config: ctx.config,
      repo: ctx.repo,
      storage: ctx.storage,
      provider,
      now: () => ctx.clock.now,
    });
    worker.start();
    try {
      await waitFor(() => [chosen, detected].every((t) => ctx.repo.get(t.id)?.status === 'done'));
    } finally {
      await worker.stop();
    }
    expect(languages).toHaveLength(2);
    expect(languages).toEqual(expect.arrayContaining(['fr', null]));
    expect(ctx.repo.get(chosen.id)).toMatchObject({ requestedLanguage: 'fr', languageCode: 'fr' });
    expect(ctx.repo.get(detected.id)).toMatchObject({ requestedLanguage: null, languageCode: 'en' });
  });
});
