import { isWhisperLanguage, WHISPER_LANGUAGES } from '../../../shared/languages';
import type { RecognizerId } from './recognizer';
import {
  chooseRecognizer,
  describeSpeakerLanguages,
  fallbackRecognizer,
  FLEURS_WER,
  languageName,
  listNames,
  mainLanguage,
  needsOverall,
  qualityWhisper,
  rankLanguages,
  recheckedLanguage,
  speakerLanguage,
  whisperLanguage,
  WHISPER_IDS,
  type LanguageGuess,
} from './routing';

const guess = (code: string, probability: number): LanguageGuess => ({
  code,
  probability,
  ranked: [{ code, probability }],
});

describe('chooseRecognizer', () => {
  it('keeps the quality mode’s Whisper for English', () => {
    expect(chooseRecognizer('en', 'standard')).toBe('whisper-tiny');
    expect(chooseRecognizer('en', 'high')).toBe('whisper-base');
    expect(chooseRecognizer('en', 'ultra')).toBe('whisper-small');
  });

  it('steps other languages up to the smallest Whisper that is good for them, never Tiny', () => {
    expect(chooseRecognizer('es', 'standard')).toBe('whisper-base'); // Tiny 15.9 %, but never Tiny
    expect(chooseRecognizer('de', 'standard')).toBe('whisper-base'); // Base 17.9 %
    expect(chooseRecognizer('pt', 'high')).toBe('whisper-base');
    expect(chooseRecognizer('fr', 'standard')).toBe('whisper-small'); // Base 28.5 %, Small 15.0 %
    expect(chooseRecognizer('ru', 'high')).toBe('whisper-small'); // Base 20.5 %
    for (const code of ['tr', 'pl', 'nl', 'uk', 'id', 'ca', 'ms']) {
      expect(chooseRecognizer(code, 'standard')).toBe('whisper-small');
    }
    // Small is the best Whisper here even if not good: 20–30 %.
    for (const code of ['sv', 'vi', 'th', 'fi', 'no', 'tl', 'ro']) {
      expect(chooseRecognizer(code, 'high')).toBe('whisper-small');
    }
    // The quality mode is the minimum.
    expect(chooseRecognizer('es', 'ultra')).toBe('whisper-small');
  });

  it('sends Chinese, Cantonese, Japanese and Korean to SenseVoice', () => {
    for (const code of ['zh', 'yue', 'ja', 'ko'])
      expect(chooseRecognizer(code, 'standard')).toBe('sensevoice');
  });

  it('sends languages where Whisper Small stays poor, or that FLEURS lacks, to Omnilingual ASR', () => {
    for (const code of ['ar', 'hi', 'fa', 'cs', 'el', 'ta', 'sw', 'bn', 'hu', 'da', 'gl']) {
      expect(chooseRecognizer(code, 'ultra')).toBe('omnilingual');
    }
    // Whisper Small measured as good as or better than Omnilingual for these; phones can't run it.
    for (const code of ['ur', 'he']) {
      expect(chooseRecognizer(code, 'standard')).toBe('whisper-small');
      expect(chooseRecognizer(code, 'standard', true)).toBe('omnilingual');
    }
    for (const code of ['eu', 'sq', 'la', 'haw', 'nn'])
      expect(chooseRecognizer(code, 'high')).toBe('omnilingual');
  });

  it('caps Whisper at Base on phones, where Omnilingual takes what Base does poorly', () => {
    expect(qualityWhisper('ultra', true)).toBe('whisper-base');
    expect(chooseRecognizer('en', 'ultra', true)).toBe('whisper-base');
    expect(chooseRecognizer('fr', 'standard', true)).toBe('whisper-base'); // Base 28.5 %
    expect(chooseRecognizer('tr', 'standard', true)).toBe('whisper-base'); // Base 27.5 %
    expect(chooseRecognizer('pl', 'standard', true)).toBe('omnilingual'); // Base 30.8 %
    expect(chooseRecognizer('ja', 'standard', true)).toBe('sensevoice');
    // Without the CTC models on phones, Base is all there is.
    expect(chooseRecognizer('pl', 'standard', true, false)).toBe('whisper-base');
    expect(chooseRecognizer('ja', 'standard', true, false)).toBe('whisper-base');
    expect(chooseRecognizer('ar', 'high', true, false)).toBe('whisper-base');
  });

  it('routes every Whisper language, never to a smaller Whisper for a higher quality mode', () => {
    const rank = (id: RecognizerId) => WHISPER_IDS.indexOf(id as (typeof WHISPER_IDS)[number]);
    for (const code of WHISPER_LANGUAGES) {
      for (const lite of [false, true]) {
        const ids = (['standard', 'high', 'ultra'] as const).map((q) => chooseRecognizer(code, q, lite));
        const whispers = ids.filter((id) => id.startsWith('whisper-'));
        expect(whispers.map(rank)).toEqual([...whispers.map(rank)].sort());
        if (lite) expect(ids).not.toContain('whisper-small');
      }
    }
    expect(Object.keys(FLEURS_WER).every(isWhisperLanguage)).toBe(true);
  });
});

describe('fallbackRecognizer', () => {
  it('replaces SenseVoice and Omnilingual by the largest Whisper, then by the one that loaded', () => {
    expect(fallbackRecognizer('sensevoice', 'whisper-base', false)).toBe('whisper-small');
    expect(fallbackRecognizer('omnilingual', 'whisper-tiny', true)).toBe('whisper-base');
    expect(fallbackRecognizer('whisper-small', 'whisper-base', false)).toBe('whisper-base');
    expect(fallbackRecognizer('whisper-base', 'whisper-base', false)).toBeNull();
  });

  it('gives Whisper Cantonese as Chinese', () => {
    expect(whisperLanguage('yue')).toBe('zh');
    expect(whisperLanguage('fr')).toBe('fr');
  });
});

describe('language detection', () => {
  it('turns Whisper’s language scores into ranked probabilities', () => {
    const out = rankLanguages(
      [
        { code: 'en', score: 1 },
        { code: 'fr', score: 3 },
        { code: 'de', score: 2 },
      ],
      2,
    );
    expect(out.code).toBe('fr');
    expect(out.ranked.map((r) => r.code)).toEqual(['fr', 'de']);
    const z = Math.exp(0) + Math.exp(-1) + Math.exp(-2);
    expect(out.probability).toBeCloseTo(1 / z);
    expect(out.ranked[1]!.probability).toBeCloseTo(Math.exp(-1) / z);
    expect(rankLanguages([]).code).toBe('en');
  });

  it('keeps a speaker’s own language when sure or based on enough speech', () => {
    const overall = guess('en', 0.99);
    expect(speakerLanguage(guess('fr', 0.95), 4, overall)).toBe('fr');
    expect(speakerLanguage(guess('fr', 0.5), 4, overall)).toBe('en');
    expect(speakerLanguage(guess('hr', 0.5), 25, overall)).toBe('hr');
    expect(speakerLanguage(null, 0.5, overall)).toBe('en');
    expect(needsOverall(guess('fr', 0.95), 2)).toBe(false);
    expect(needsOverall(guess('fr', 0.79), 9)).toBe(true);
  });

  it('changes a turn’s language only for another language detected with confidence', () => {
    expect(recheckedLanguage('en', guess('de', 0.9))).toBe('de');
    expect(recheckedLanguage('en', guess('de', 0.6))).toBeNull();
    expect(recheckedLanguage('en', guess('en', 0.99))).toBeNull();
  });

  it('names the language spoken most', () => {
    expect(
      mainLanguage([
        { lang: 'fr', startMs: 0, endMs: 3000 },
        { lang: 'en', startMs: 3000, endMs: 5000 },
        { lang: 'en', startMs: 6000, endMs: 8000 },
      ]),
    ).toBe('en');
    expect(
      mainLanguage([
        { lang: 'de', startMs: 0, endMs: 10 },
        { lang: 'it', startMs: 20, endMs: 30 },
      ]),
    ).toBe('de');
    expect(mainLanguage([])).toBeNull();
  });
});

describe('progress wording', () => {
  it('names languages in English', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('yue')).toBe('Cantonese');
    expect(languageName('jw')).toBe('Javanese');
    expect(languageName('qq')).toBe('qq');
  });

  it('lists languages and speakers', () => {
    expect(listNames(['French'])).toBe('French');
    expect(listNames(['Arabic', 'Hindi', 'Persian'])).toBe('Arabic, Hindi and Persian');
    expect(describeSpeakerLanguages(['fr'])).toBe('French');
    expect(describeSpeakerLanguages(['fr', 'fr'])).toBe('French (2 speakers)');
    expect(describeSpeakerLanguages(['en', 'fr', 'fr'])).toBe('French (2 speakers) and English (1 speaker)');
  });
});
