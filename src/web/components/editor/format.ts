import { baseLanguage, textDirection } from '../../../shared/languages';
import type { TranscriptRow } from '../../../shared/types';

/** BCP-47 tag for a provider or Whisper language code ("en_us" -> "en-US", "jw" -> "jv"), or null. */
export function languageTag(code: string | null | undefined): string | null {
  if (!code) return null;
  const tag = code.replace(/_/g, '-').replace(/^jw(?=-|$)/i, 'jv');
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Display name of a provider language code ("en", "en_us", "pt-BR", "jw"), falling back to the code
 * itself. English by default, like the rest of the interface.
 */
export function languageName(code: string | null | undefined, locale = 'en'): string {
  if (!code) return '—';
  const tag = languageTag(code);
  if (!tag) return code;
  try {
    const name = new Intl.DisplayNames(locale, { type: 'language' }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : code;
  } catch {
    // No Intl.DisplayNames support.
    return code;
  }
}

/**
 * `lang` and `dir` for an element showing text in `code`, so screen readers pick the right voice,
 * browsers the right CJK glyphs and right-to-left text reads correctly. Unknown language: no `lang`
 * (rather than the page's "en"), and the direction comes from the text itself.
 */
export function textAttributes(code: string | null | undefined): { lang?: string; dir: 'rtl' | 'auto' } {
  const lang = languageTag(code);
  return lang ? { lang, dir: textDirection(code) } : { dir: 'auto' };
}

/**
 * Languages spoken in `rows`, one code per language, the most spoken first. A row without its own
 * language counts as `fallback` (the transcript's).
 */
export function spokenLanguages(rows: readonly TranscriptRow[], fallback: string | null): string[] {
  const byLanguage = new Map<string, { code: string; ms: number }>();
  for (const row of rows) {
    const code = row.lang ?? fallback;
    const key = baseLanguage(code);
    if (!code || !key) continue;
    const entry = byLanguage.get(key) ?? { code, ms: 0 };
    entry.ms += Math.max(0, row.endMs - row.startMs);
    byLanguage.set(key, entry);
  }
  // Stable sort: equal amounts keep their order of first appearance.
  return [...byLanguage.values()].sort((a, b) => b.ms - a.ms).map((e) => e.code);
}

export function formatDateTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
