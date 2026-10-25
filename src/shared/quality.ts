import { QUALITY_MODES, type QualityMode, type QualityModeInfo } from './types';

export const DEFAULT_QUALITY_MODE: QualityMode = 'high';

/** Free Ultra High uses per client per day unless configured otherwise. */
export const DEFAULT_ULTRA_DAILY_LIMIT = 3;

type ModeDefinition = Omit<QualityModeInfo, 'dailyLimit'>;

/**
 * What each mode does. Providers map these to concrete models (see providers/*):
 *   standard -> the provider's faster model (AssemblyAI universal-2, Deepgram nova-2)
 *   high     -> the provider's best general model (AssemblyAI universal-3-5-pro, Deepgram nova-3)
 *   ultra    -> the best model plus word-level speaker refinement: rows are rebuilt from per-word
 *               speaker labels, so a row starts exactly where the speaker changes
 */
export const QUALITY_MODE_DEFINITIONS: Record<QualityMode, ModeDefinition> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    tagline: 'Fast, for clear recordings',
    description: 'A faster speech model. Good for clean audio with one or two speakers.',
    speed: 5,
    accuracy: 3,
  },
  high: {
    id: 'high',
    label: 'High',
    tagline: 'Best for most recordings',
    description: 'The most accurate general speech model, with automatic language detection.',
    speed: 4,
    accuracy: 4,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra High',
    tagline: 'Maximum accuracy for hard audio',
    description:
      'The most accurate model plus word-level speaker refinement, so rows split exactly where the ' +
      'speaker changes. Best for fast-paced conversations, interviews and meetings.',
    speed: 3,
    accuracy: 5,
  },
};

export function isQualityMode(value: unknown): value is QualityMode {
  return typeof value === 'string' && (QUALITY_MODES as readonly string[]).includes(value);
}

/** Mode list for /api/config, with the limited modes' daily limits. */
export function qualityModeInfo(limits: Partial<Record<QualityMode, number | null>>): QualityModeInfo[] {
  return QUALITY_MODES.map((id) => ({ ...QUALITY_MODE_DEFINITIONS[id], dailyLimit: limits[id] ?? null }));
}

/** "YYYY-MM-DD" in UTC; daily limits reset at UTC midnight. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** ISO timestamp of the next UTC midnight. */
export function nextUtcMidnight(now: number = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}
