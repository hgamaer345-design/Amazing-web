// Languages the app can be told to expect, and script facts the UI and exports need.

/**
 * Languages Whisper (the in-browser engine) knows, as ISO 639-1 codes ("haw" and "jw" as Whisper
 * spells them), in Whisper's order (roughly by amount of training data).
 */
// prettier-ignore
export const WHISPER_LANGUAGES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id',
  'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg',
  'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br',
  'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so',
  'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo', 'ht', 'ps', 'tk', 'nn', 'mt',
  'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su',
] as const;

export type WhisperLanguage = (typeof WHISPER_LANGUAGES)[number];

export function isWhisperLanguage(code: unknown): code is WhisperLanguage {
  return typeof code === 'string' && (WHISPER_LANGUAGES as readonly string[]).includes(code);
}

/** Primary subtag of a language code: "en_us" / "pt-BR" -> "en" / "pt"; Whisper's "jw" -> "jv". */
export function baseLanguage(code: string | null | undefined): string | null {
  if (!code) return null;
  const base = code.toLowerCase().split(/[-_]/)[0]!;
  return base === 'jw' ? 'jv' : base;
}

/** Languages written right to left (among those the engines produce). */
const RTL = new Set(['ar', 'fa', 'he', 'iw', 'ps', 'sd', 'ur', 'yi', 'ug', 'dv', 'ku', 'ckb']);

export function isRightToLeft(code: string | null | undefined): boolean {
  const base = baseLanguage(code);
  return base !== null && RTL.has(base);
}

/** Text direction for an element showing text in `code`: known RTL languages, otherwise "auto". */
export function textDirection(code: string | null | undefined): 'rtl' | 'auto' {
  return isRightToLeft(code) ? 'rtl' : 'auto';
}
