/** Display name of a provider language code ("en", "en_us", "pt-BR"), falling back to the code itself. */
export function languageName(code: string | null | undefined, locale?: string): string {
  if (!code) return '—';
  const tag = code.replace(/_/g, '-');
  try {
    const name = new Intl.DisplayNames(locale, { type: 'language' }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : code;
  } catch {
    // RangeError for codes that aren't valid BCP-47 tags (or no Intl.DisplayNames support).
    return code;
  }
}

export function formatDateTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
