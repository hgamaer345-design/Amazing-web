import { useId } from 'react';
import { WHISPER_LANGUAGES } from '../../../shared/languages';
import { languageName } from '../editor/format';

/** Listed first: the languages most recordings are in. */
// prettier-ignore
const COMMON_LANGUAGES: ReadonlySet<string> = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ru', 'ar', 'hi',
]);

export interface LanguageOption {
  code: string;
  name: string;
}

// Built on first use: 99 Intl.DisplayNames lookups and a sort.
let cachedOptions: { common: LanguageOption[]; other: LanguageOption[] } | null = null;

/** Every language the app can be told to expect, by English name: the common ones, then the rest. */
export function languageOptions(): { common: LanguageOption[]; other: LanguageOption[] } {
  if (cachedOptions) return cachedOptions;
  const collator = new Intl.Collator('en');
  const byName = (a: LanguageOption, b: LanguageOption) => collator.compare(a.name, b.name);
  const all = WHISPER_LANGUAGES.map((code) => ({ code, name: languageName(code) })).sort(byName);
  cachedOptions = {
    common: all.filter((o) => COMMON_LANGUAGES.has(o.code)),
    other: all.filter((o) => !COMMON_LANGUAGES.has(o.code)),
  };
  return cachedOptions;
}

export interface LanguagePickerProps {
  /** A WHISPER_LANGUAGES code, or null to detect the language automatically. */
  value: string | null;
  onChange: (language: string | null) => void;
  /** The in-browser demo, where some languages need another speech model (downloaded once). */
  demo: boolean;
  disabled?: boolean;
}

const AUTO = 'auto';

/** Languages the demo transcribes with the chosen quality's own model (others may need a bigger one). */
const DEMO_BUILT_IN = new Set(['en', 'es']);

function languageHint(value: string | null, demo: boolean): string {
  if (!value) {
    return demo
      ? 'Detected for each speaker. Languages other than English and Spanish may download a larger ' +
          'speech model the first time.'
      : 'Choose one if automatic detection gets it wrong.';
  }
  return demo && !DEMO_BUILT_IN.has(value)
    ? 'Every speaker is transcribed in this language. The first time, this may download a larger speech model.'
    : 'Every speaker is transcribed in this language.';
}

/**
 * "Language: Detect automatically" or one of the supported languages. A native select: compact,
 * type-ahead ("ja…" jumps to Japanese) and the platform's own picker on phones.
 */
export function LanguagePicker({ value, onChange, demo, disabled }: LanguagePickerProps) {
  const id = useId();
  const { common, other } = languageOptions();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Language
      </label>
      <select
        id={id}
        className="select language-select"
        value={value ?? AUTO}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value === AUTO ? null : e.target.value)}
      >
        <option value={AUTO}>Detect automatically</option>
        <optgroup label="Common languages">
          {common.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="All other languages">
          {other.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </optgroup>
      </select>
      <span id={`${id}-hint`} className="field-hint">
        {languageHint(value, demo)}
      </span>
    </div>
  );
}
