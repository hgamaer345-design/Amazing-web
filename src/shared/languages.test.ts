import {
  baseLanguage,
  isRightToLeft,
  isWhisperLanguage,
  textDirection,
  WHISPER_LANGUAGES,
} from './languages';

describe('languages', () => {
  it("lists Whisper's 99 languages once each", () => {
    expect(WHISPER_LANGUAGES).toHaveLength(99);
    expect(new Set(WHISPER_LANGUAGES).size).toBe(99);
    expect(isWhisperLanguage('fr')).toBe(true);
    expect(isWhisperLanguage('xx')).toBe(false);
    expect(isWhisperLanguage(undefined)).toBe(false);
  });

  it('knows which languages are written right to left', () => {
    expect(isRightToLeft('ar')).toBe(true);
    expect(isRightToLeft('he')).toBe(true);
    expect(isRightToLeft('ur')).toBe(true);
    expect(isRightToLeft('fa_ir')).toBe(true);
    expect(isRightToLeft('en')).toBe(false);
    expect(isRightToLeft(null)).toBe(false);
    expect(textDirection('yi')).toBe('rtl');
    expect(textDirection('ja')).toBe('auto');
  });

  it('reduces provider codes to the base language', () => {
    expect(baseLanguage('en_us')).toBe('en');
    expect(baseLanguage('pt-BR')).toBe('pt');
    expect(baseLanguage('jw')).toBe('jv');
    expect(baseLanguage('')).toBeNull();
  });
});
