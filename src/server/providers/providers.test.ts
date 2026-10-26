import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createAssemblyAiProvider, mapAssemblyAiTranscript } from './assemblyai';
import { createDeepgramProvider, deepgramLanguage, mapDeepgramResponse } from './deepgram';
import { ProviderError, type TranscribeRequest } from './types';

let dir: string;
let audioPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-providers-'));
  audioPath = path.join(dir, 'a.wav');
  fs.writeFileSync(audioPath, Buffer.alloc(256, 1));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function request(overrides: Partial<TranscribeRequest> = {}): TranscribeRequest {
  return {
    audioPath,
    mimeType: 'audio/wav',
    sizeBytes: 256,
    speakersExpected: null,
    quality: 'high',
    signal: new AbortController().signal,
    onJobCreated: () => undefined,
    ...overrides,
  };
}

/** Stubs fetch; `respond` sees each call after the uploaded file has been read. */
function stubFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
      calls.push({ url, init });
      return respond(url, init);
    }),
  );
  return calls;
}

describe('AssemblyAI', () => {
  const provider = () =>
    createAssemblyAiProvider({
      apiKey: 'key',
      baseUrl: 'https://aai.test',
      speechModels: ['universal-3-5-pro', 'universal-2'],
      standardSpeechModels: ['universal-2'],
      pollIntervalMs: 1,
    });

  function stubAssemblyAi() {
    return stubFetch((url, init) => {
      if (url.endsWith('/v2/upload')) return json({ upload_url: 'https://cdn.test/x' });
      if (url.endsWith('/v2/transcript') && init.method === 'POST')
        return json({ id: 't1', status: 'queued' });
      return json({
        id: 't1',
        status: 'completed',
        language_code: 'fr',
        utterances: [{ speaker: 'A', start: 0, end: 900, text: 'Bonjour.' }],
      });
    });
  }

  const submitted = (calls: { url: string; init: RequestInit }[]) =>
    JSON.parse(String(calls.find((c) => c.url.endsWith('/v2/transcript'))!.init.body)) as Record<
      string,
      unknown
    >;

  it('sends the chosen language instead of detecting it', async () => {
    const calls = stubAssemblyAi();
    const result = await provider().transcribe(request({ language: 'fr' }));
    const body = submitted(calls);
    expect(body.language_code).toBe('fr');
    expect(body).not.toHaveProperty('language_detection');
    expect(body.speech_models).toEqual(['universal-3-5-pro', 'universal-2']);
    expect(result.languageCode).toBe('fr');
  });

  it("keeps Whisper's own codes, which AssemblyAI uses too", async () => {
    const calls = stubAssemblyAi();
    await provider().transcribe(request({ language: 'jw' }));
    expect(submitted(calls).language_code).toBe('jw');
  });

  it('detects the language when none was chosen', async () => {
    for (const language of [null, undefined]) {
      const calls = stubAssemblyAi();
      await provider().transcribe(request({ language }));
      const body = submitted(calls);
      expect(body.language_detection).toBe(true);
      expect(body).not.toHaveProperty('language_code');
    }
  });

  it('joins words without spaces in Chinese and Japanese, with spaces otherwise', () => {
    const words = (texts: string[]) =>
      texts.map((text, i) => ({ text, start: i * 300, end: i * 300 + 300, speaker: 'A' }));
    const zh = mapAssemblyAiTranscript({
      id: 'x',
      status: 'completed',
      words: words(['我们', '今天', '讨论']),
    });
    expect(zh.segments[0]!.text).toBe('我们今天讨论');
    const en = mapAssemblyAiTranscript({ id: 'x', status: 'completed', words: words(['Hello', 'there.']) });
    expect(en.segments[0]!.text).toBe('Hello there.');
    const th = mapAssemblyAiTranscript({ id: 'x', status: 'completed', words: words(['สวัสดี', 'ครับ']) });
    expect(th.segments[0]!.text).toBe('สวัสดี ครับ');
  });
});

describe('Deepgram', () => {
  const provider = () =>
    createDeepgramProvider({
      apiKey: 'key',
      baseUrl: 'https://dg.test',
      model: 'nova-3',
      standardModel: 'nova-2',
      diarizeModel: 'latest',
    });
  const ok = () => json({ results: { utterances: [{ start: 0, end: 1, transcript: 'Hola.', speaker: 0 }] } });
  const params = (calls: { url: string }[]) => new URL(calls[0]!.url).searchParams;

  it('sends the chosen language instead of detecting it', async () => {
    const calls = stubFetch(ok);
    await provider().transcribe(request({ language: 'es' }));
    expect(params(calls).get('language')).toBe('es');
    expect(params(calls).has('detect_language')).toBe(false);
    expect(params(calls).get('model')).toBe('nova-3');
  });

  it('maps Whisper codes to the BCP-47 tags Deepgram expects', async () => {
    expect(deepgramLanguage('jw')).toBe('jv');
    expect(deepgramLanguage('haw')).toBe('haw');
    expect(deepgramLanguage('zh')).toBe('zh');
    expect(deepgramLanguage(null)).toBeNull();
    const calls = stubFetch(ok);
    await provider().transcribe(request({ language: 'jw', quality: 'standard' }));
    expect(params(calls).get('language')).toBe('jv');
    expect(params(calls).get('model')).toBe('nova-2');
  });

  it('detects the language when none was chosen', async () => {
    const calls = stubFetch(ok);
    await provider().transcribe(request({ language: null }));
    expect(params(calls).get('detect_language')).toBe('true');
    expect(params(calls).has('language')).toBe(false);
  });

  it('says which model and language Deepgram refused', async () => {
    stubFetch(() => json({ err_msg: 'No such model/language/tier combination found.' }, 400));
    const err = await provider()
      .transcribe(request({ language: 'sw' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'failed', status: 400 });
    expect((err as ProviderError).detail).toBe(
      'No such model/language/tier combination found. (model "nova-3", language "sw")',
    );
  });

  it('joins words and sentences without spaces in Chinese and Japanese', () => {
    const ja = mapDeepgramResponse({
      results: {
        channels: [
          {
            detected_language: 'ja',
            alternatives: [
              {
                words: ['今日', 'は', 'いい', '天気', 'です', 'ね。'].map((w, i) => ({
                  word: w,
                  punctuated_word: w,
                  start: i * 0.3,
                  end: i * 0.3 + 0.3,
                  speaker: 0,
                })),
              },
            ],
          },
        ],
      },
    });
    expect(ja.segments[0]!.text).toBe('今日はいい天気ですね。');
    const paragraphs = (sentences: string[]) =>
      mapDeepgramResponse({
        results: {
          channels: [
            {
              alternatives: [
                {
                  paragraphs: {
                    paragraphs: [
                      { speaker: 0, start: 0, end: 3, sentences: sentences.map((text) => ({ text })) },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }).segments[0]!.text;
    expect(paragraphs(['好的。', '谢谢。', '再见。'])).toBe('好的。谢谢。再见。');
    expect(paragraphs(['Okay.', 'Thanks.'])).toBe('Okay. Thanks.');
  });
});
