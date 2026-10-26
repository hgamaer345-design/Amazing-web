// The worker's transcription loop with fake models: language per speaker, one model per language
// group, fallbacks, the per-turn language check and progress.
import type { Recognizer, RecognizerId } from './recognizer';
import type { LanguageGuess } from './routing';
import type { Turn } from './turns';

vi.mock('./models', () => ({
  configureRuntime: vi.fn(),
  DIARIZATION_SETTINGS: {},
  isWhisperRecognizer: (r: { id: string }) => r.id.startsWith('whisper-'),
  loadRecognizer: vi.fn(),
  loadSpeakerModels: vi.fn(),
  ModelLoadError: class extends Error {},
  RECOGNIZER_INFO: {
    'whisper-tiny': { label: 'Whisper Tiny', approxMB: 41 },
    'whisper-base': { label: 'Whisper Base', approxMB: 77 },
    'whisper-small': { label: 'Whisper Small', approxMB: 249 },
    sensevoice: { label: 'SenseVoice', approxMB: 240 },
    omnilingual: { label: 'Omnilingual ASR', approxMB: 365 },
  },
  speakerModelRunners: vi.fn(),
}));

const { JobModels, RecognizerShelf, transcribeTurns, loadingMessage } = await import('./speech.worker');

const SR = 16000;
const LABELS: Record<RecognizerId, string> = {
  'whisper-tiny': 'Whisper Tiny',
  'whisper-base': 'Whisper Base',
  'whisper-small': 'Whisper Small',
  sensevoice: 'SenseVoice',
  omnilingual: 'Omnilingual ASR',
};
/** Turn i's samples all hold the value i + 1, so a fake model knows which turn it hears. */
function audioFor(turns: Turn[]): Float32Array {
  const audio = new Float32Array(Math.max(...turns.map((t) => t.end)));
  turns.forEach((t, i) => audio.fill(i + 1, t.start, t.end));
  return audio;
}
const turn = (speaker: number, fromSec: number, toSec: number): Turn => ({
  speaker,
  start: fromSec * SR,
  end: toSec * SR,
});
const sure = (code: string, probability = 0.95): LanguageGuess => ({
  code,
  probability,
  ranked: [{ code, probability }],
});

interface Scenario {
  /** Language detection by the first turn heard (a speaker's sample starts with their first turn). */
  detect?: (turnIndex: number, sample: Float32Array, model: RecognizerId) => LanguageGuess;
  /** Turns whose first Whisper decode is doubtful (when transcribed in `lang`). */
  doubtful?: (turnIndex: number, lang: string) => boolean;
  failing?: RecognizerId[];
  /** Models that hear nothing. */
  silent?: RecognizerId[];
}

function setup(scenario: Scenario = {}) {
  const calls: string[] = [];
  const make = (id: RecognizerId): Recognizer & Record<string, unknown> => {
    const text = (clip: Float32Array, lang: string) => `${id}:${lang}:${clip[0]! - 1}`;
    const base = {
      id,
      label: LABELS[id],
      async transcribe(clip: Float32Array, lang: string) {
        calls.push(`transcribe ${id} ${clip[0]! - 1} ${lang}`);
        return scenario.silent?.includes(id) ? '' : text(clip, lang);
      },
      async dispose() {
        calls.push(`dispose ${id}`);
      },
    };
    if (!id.startsWith('whisper-')) return base;
    return {
      ...base,
      async transcribeChecked(clip: Float32Array, lang: string) {
        calls.push(`checked ${id} ${clip[0]! - 1} ${lang}`);
        const doubtful = scenario.doubtful?.(clip[0]! - 1, lang) ?? false;
        // A doubtful decode is a less likely one.
        return { text: text(clip, lang), doubtful, confidence: doubtful ? -1.5 : -0.3 };
      },
      async detectLanguage(sample: Float32Array) {
        calls.push(`detect ${sample[0]! - 1} ${(sample.length / SR).toFixed(0)}s`);
        return scenario.detect?.(sample[0]! - 1, sample, id) ?? sure('en');
      },
    };
  };
  const shelf = new RecognizerShelf(async (id, onProgress) => {
    calls.push(`load ${id}`);
    onProgress(10_000_000, 100_000_000);
    onProgress(100_000_000, 100_000_000);
    if (scenario.failing?.includes(id)) throw new Error(`${id} is not available`);
    return make(id);
  });
  const messages: { stage: string; message: string; fraction: number | null }[] = [];
  const progress = (stage: string, message: string, fraction: number | null) =>
    messages.push({ stage, message, fraction });
  return { calls, shelf, messages, progress };
}

async function run(
  turns: Turn[],
  opts: { quality?: 'standard' | 'high' | 'ultra'; lite?: boolean; language?: string | null } & Scenario = {},
) {
  const env = setup(opts);
  const language = opts.language ?? null;
  const models = new JobModels(env.shelf, opts.quality ?? 'high', opts.lite ?? false, env.progress, language);
  await models.load(models.first);
  env.calls.length = 0;
  const result = await transcribeTurns({
    audio: audioFor(turns),
    turns,
    language,
    models,
    start: 0.3,
    progress: env.progress,
  });
  return { ...env, result };
}

describe('transcribeTurns', () => {
  it('detects each speaker’s language and gives each language its model, in time order', async () => {
    // Speaker 0 speaks English (turns 0, 2), speaker 1 French (turns 1, 3).
    const turns = [turn(0, 0, 10), turn(1, 10, 22), turn(0, 22, 30), turn(1, 30, 40)];
    const { result, calls, messages } = await run(turns, {
      detect: (i) => (i === 1 ? sure('fr', 0.9) : sure('en', 0.98)),
    });
    expect(result.speakers.map((s) => [s.speaker, s.language, s.seconds])).toEqual([
      [0, 'en', 18],
      [1, 'fr', 22],
    ]);
    expect(result.overall).toBeNull();
    expect(calls).toEqual([
      'detect 0 18s',
      'detect 1 22s',
      // The Whisper already loaded first, then French's (Base is replaced: one Whisper at a time).
      'checked whisper-base 0 en',
      'checked whisper-base 2 en',
      'dispose whisper-base',
      'load whisper-small',
      // Small checks the French speaker's language again (Base detected it).
      'detect 1 22s',
      'checked whisper-small 1 fr',
      'checked whisper-small 3 fr',
    ]);
    expect(result.segments.map((s) => [s.speaker, s.startMs, s.text, s.lang])).toEqual([
      ['S0', 0, 'whisper-base:en:0', 'en'],
      ['S1', 10_000, 'whisper-small:fr:1', 'fr'],
      ['S0', 22_000, 'whisper-base:en:2', 'en'],
      ['S1', 30_000, 'whisper-small:fr:3', 'fr'],
    ]);
    expect(result.languageCode).toBe('fr');
    expect(messages.map((m) => m.message)).toContain(
      'Detected English (1 speaker) and French (1 speaker) — downloading Whisper Small (9.5 MB of 95.4 MB), ' +
        'more accurate for French — only needed once…',
    );
    expect(messages.map((m) => m.message)).toContain('Transcribing French with Whisper Small…');
    const fractions = messages.map((m) => m.fraction).filter((f): f is number => f !== null);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[0]).toBe(0.3);
    expect(Math.max(...fractions)).toBeLessThan(1);
  });

  it('gives unsure speakers with little speech the whole recording’s language', async () => {
    // Speaker 1 says 4 s and Whisper is unsure; speaker 2 says 20 s, unsure, but keeps their own.
    const turns = [turn(0, 0, 20), turn(1, 20, 24), turn(2, 24, 44)];
    const { result, calls } = await run(turns, {
      detect: (i, sample) =>
        sample.length === 30 * SR
          ? sure('de')
          : i === 0
            ? sure('de')
            : i === 1
              ? sure('nl', 0.5)
              : sure('sv', 0.6),
    });
    expect(result.speakers.map((s) => s.language)).toEqual(['de', 'de', 'sv']);
    expect(result.overall?.code).toBe('de');
    expect(calls.filter((c) => c.startsWith('detect'))).toEqual([
      'detect 0 20s',
      'detect 1 4s',
      'detect 2 20s',
      'detect 0 30s',
      'detect 2 20s', // by Whisper Small, which Swedish goes to
    ]);
  });

  it('skips detection for the language the user chose', async () => {
    const turns = [turn(0, 0, 5), turn(1, 5, 9)];
    const { result, calls } = await run(turns, { language: 'de', doubtful: () => true });
    expect(calls).toEqual(['transcribe whisper-base 0 de', 'transcribe whisper-base 1 de']);
    expect(result.segments.map((s) => s.lang)).toEqual(['de', 'de']);
    expect(result.languageCode).toBe('de');
  });

  it('uses the largest Whisper when SenseVoice or Omnilingual can’t be loaded', async () => {
    const turns = [turn(0, 0, 6), turn(1, 6, 12), turn(2, 12, 18)];
    const { result, calls, messages } = await run(turns, {
      detect: (i) => sure(['ja', 'fr', 'ar'][i]!),
      failing: ['sensevoice', 'omnilingual'],
    });
    // Japanese and Arabic join French on Whisper Small, loaded once.
    expect(calls.filter((c) => c.startsWith('load'))).toEqual([
      'load sensevoice',
      'load whisper-small',
      'load omnilingual',
    ]);
    expect(result.segments.map((s) => [s.text, s.lang])).toEqual([
      ['whisper-small:ja:0', 'ja'],
      ['whisper-small:fr:1', 'fr'],
      ['whisper-small:ar:2', 'ar'],
    ]);
    expect(messages.map((m) => m.message)).toContain(
      'SenseVoice couldn’t be loaded — using Whisper Small instead…',
    );
  });

  it('lets a larger Whisper check the language Tiny detected, and moves the speaker if it disagrees', async () => {
    // Tiny takes speaker 0 (Ukrainian) for Russian and speaker 1 (Arabic) for Turkish; both go to
    // Whisper Small, which knows better. Speaker 2 (English) stays with Tiny.
    const turns = [turn(0, 0, 6), turn(1, 6, 18), turn(2, 18, 24), turn(0, 24, 30)];
    const truth = ['uk', 'ar', 'en', 'uk'];
    const { result, calls } = await run(turns, {
      quality: 'standard',
      detect: (i, _sample, model) =>
        model === 'whisper-tiny' ? sure(['ru', 'tr', 'en'][i]!, 0.93) : sure(truth[i]!, 0.99),
    });
    expect(result.speakers.map((s) => [s.language, s.own?.code, s.checked?.code])).toEqual([
      ['uk', 'ru', 'uk'],
      ['ar', 'tr', 'ar'],
      ['en', 'en', undefined],
    ]);
    // Arabic goes on to Omnilingual ASR.
    expect(calls.filter((c) => c.startsWith('load'))).toEqual(['load whisper-small', 'load omnilingual']);
    expect(result.segments.map((s) => [s.text, s.lang])).toEqual([
      ['whisper-small:uk:0', 'uk'],
      ['omnilingual:ar:1', 'ar'],
      ['whisper-tiny:en:2', 'en'],
      ['whisper-small:uk:3', 'uk'],
    ]);
  });

  it('tries a model that failed only once, falling back to the quality mode’s Whisper', async () => {
    const turns = [turn(0, 0, 6), turn(1, 6, 12)];
    const { result, calls } = await run(turns, {
      detect: (i) => sure(['ar', 'fr'][i]!),
      failing: ['omnilingual', 'whisper-small'],
    });
    expect(calls.filter((c) => c.startsWith('load'))).toEqual([
      'load omnilingual',
      'load whisper-small',
      'load whisper-base',
    ]);
    expect(result.segments.map((s) => s.text)).toEqual(['whisper-base:ar:0', 'whisper-base:fr:1']);
  });

  it('fails the job only when the quality mode’s Whisper can’t be loaded', async () => {
    const env = setup({ failing: ['whisper-base'] });
    const models = new JobModels(env.shelf, 'high', false, env.progress, null);
    await expect(models.load(models.first)).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD' });
  });

  it('frees each model before loading the next on phones', async () => {
    const turns = [turn(0, 0, 6), turn(1, 6, 12), turn(2, 12, 18)];
    const { result, calls } = await run(turns, {
      lite: true,
      quality: 'standard',
      detect: (i) => sure(['en', 'fr', 'zh'][i]!),
    });
    expect(
      calls.filter((c) => !c.startsWith('detect') && !c.startsWith('checked') && !c.startsWith('transcribe')),
    ).toEqual(['dispose whisper-tiny', 'load whisper-base', 'dispose whisper-base', 'load sensevoice']);
    expect(result.segments.map((s) => s.text)).toEqual([
      'whisper-tiny:en:0',
      'whisper-base:fr:1', // capped at Base on phones
      'sensevoice:zh:2',
    ]);
  });

  it('re-detects a doubtful turn’s language and transcribes it in the language that wins', async () => {
    // Speaker 0 is English; turn 1 is German, turn 2 Japanese (and speaker 1 is Japanese), turn 3
    // (2 s) too short to check, turn 4 doubtful but its detection unsure.
    const turns = [turn(0, 0, 10), turn(0, 12, 17), turn(0, 19, 24), turn(0, 26, 28), turn(0, 30, 36)];
    turns.push(turn(1, 40, 52));
    const { result, calls } = await run(turns, {
      detect: (i, sample) =>
        sample.length > 6 * SR && i === 0
          ? sure('en')
          : [sure('en'), sure('de', 0.9), sure('ja', 0.97), sure('en'), sure('de', 0.6), sure('ja')][i]!,
      doubtful: (i, lang) => lang === 'en' && i >= 1,
    });
    expect(result.segments.map((s) => [s.text, s.lang])).toEqual([
      ['whisper-base:en:0', 'en'],
      ['whisper-base:de:1', 'de'],
      ['sensevoice:ja:2', 'ja'],
      ['whisper-base:en:3', 'en'],
      ['whisper-base:en:4', 'en'],
      ['sensevoice:ja:5', 'ja'],
    ]);
    expect(result.relanguaged).toBe(2);
    expect(calls).toContain('detect 1 5s');
    expect(calls).not.toContain('detect 3 2s');
    expect(calls).toContain('checked whisper-base 1 de');
    expect(calls).toContain('transcribe sensevoice 2 ja');
  });

  it('keeps a turn’s first text when Whisper is no surer of it in the language detected again', async () => {
    // Music in a French recording: detected as English, but transcribing it as English is no better.
    const turns = [turn(0, 0, 20), turn(0, 22, 30)];
    const { result } = await run(turns, {
      detect: (i, sample) => sure(i === 0 && sample.length === 20 * SR ? 'en' : 'fr'),
      doubtful: (i) => i === 0,
    });
    expect(result.segments.map((s) => [s.text, s.lang])).toEqual([
      ['whisper-small:fr:0', 'fr'],
      ['whisper-small:fr:1', 'fr'],
    ]);
    expect(result.relanguaged).toBe(0);
  });

  it('keeps the first text when the model a turn moved to finds nothing', async () => {
    // Speaker 0's first turn is doubtful in English and detected as Japanese (speaker 1's language),
    // but SenseVoice hears nothing in it.
    const turns = [turn(0, 0, 10), turn(0, 12, 20), turn(1, 20, 30)];
    const { result } = await run(turns, {
      detect: (i, sample) => sure(i === 0 && sample.length !== 10 * SR ? 'en' : 'ja'),
      doubtful: (i) => i === 0,
      silent: ['sensevoice'],
    });
    expect(result.segments.map((s) => [s.text, s.lang])).toEqual([
      ['whisper-base:en:0', 'en'],
      ['whisper-base:en:1', 'en'],
    ]);
    expect(result.relanguaged).toBe(1);
  });
});

describe('loadingMessage', () => {
  it('says what downloads and why, or that a cached model is being prepared', () => {
    expect(loadingMessage('Whisper Tiny', 1_048_576, 41 * 1_048_576)).toBe(
      'Downloading the Whisper Tiny speech model (1 MB of 41 MB) — only needed once…',
    );
    expect(loadingMessage('Whisper Tiny', 5, 5)).toBe('Preparing the Whisper Tiny speech model…');
    expect(loadingMessage('SenseVoice', 5, 5, { prefix: 'Detected Chinese', names: 'Chinese' })).toBe(
      'Detected Chinese — preparing SenseVoice for Chinese…',
    );
  });
});
