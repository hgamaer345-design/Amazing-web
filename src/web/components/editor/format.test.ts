import type { TranscriptRow } from '../../../shared/types';
import { languageName, languageTag, spokenLanguages, textAttributes } from './format';

const row = (startMs: number, endMs: number, lang?: string): TranscriptRow => ({
  id: `r${startMs}`,
  speakerId: 'a',
  startMs,
  endMs,
  text: 'x',
  ...(lang ? { lang } : {}),
});

describe('language formatting', () => {
  it('turns provider and Whisper codes into BCP-47 tags', () => {
    expect(languageTag('en_us')).toBe('en-US');
    expect(languageTag('pt-br')).toBe('pt-BR');
    expect(languageTag('jw')).toBe('jv');
    expect(languageTag('haw')).toBe('haw');
    expect(languageTag('not a tag')).toBeNull();
    expect(languageTag(null)).toBeNull();
  });

  it('names languages in English, whatever the browser language', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('jw')).toBe('Javanese');
    expect(languageName('en_us')).toBe('American English');
    expect(languageName('zz')).toBe('zz');
    expect(languageName(null)).toBe('—');
  });

  it('marks text with its language and direction', () => {
    expect(textAttributes('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(textAttributes('he')).toEqual({ lang: 'he', dir: 'rtl' });
    expect(textAttributes('ja')).toEqual({ lang: 'ja', dir: 'auto' });
    expect(textAttributes(null)).toEqual({ dir: 'auto' });
  });

  it('lists the languages spoken, the most spoken first', () => {
    const rows = [row(0, 1000), row(1000, 5000, 'fr'), row(5000, 6000, 'en'), row(6000, 7000, 'de')];
    // English: 2 s (one row from the transcript's language), French 4 s, German 1 s.
    expect(spokenLanguages(rows, 'en')).toEqual(['fr', 'en', 'de']);
    expect(spokenLanguages([row(0, 1000), row(1000, 2000, 'en')], 'en_us')).toEqual(['en_us']);
    expect(spokenLanguages([row(0, 1000)], null)).toEqual([]);
  });
});
