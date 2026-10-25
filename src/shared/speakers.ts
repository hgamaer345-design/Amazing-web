// Speaker colour palette and id helpers shared by the UI and exporters, so a speaker
// keeps the same colour on screen and in DOCX/XLSX exports.

export interface SpeakerColor {
  /** Strong colour for text/borders on a light background (also used in exports). */
  base: string;
  /** Soft tint for chip/row backgrounds in light mode. */
  tint: string;
  /** Text colour for dark mode. */
  dark: string;
  /** Soft tint for chip/row backgrounds in dark mode. */
  darkTint: string;
}

export const SPEAKER_COLORS: readonly SpeakerColor[] = [
  { base: '#1d4ed8', tint: '#dbeafe', dark: '#93c5fd', darkTint: '#1e3a8a' }, // blue
  { base: '#be185d', tint: '#fce7f3', dark: '#f9a8d4', darkTint: '#831843' }, // pink
  { base: '#047857', tint: '#d1fae5', dark: '#6ee7b7', darkTint: '#064e3b' }, // emerald
  { base: '#b45309', tint: '#fef3c7', dark: '#fcd34d', darkTint: '#78350f' }, // amber
  { base: '#6d28d9', tint: '#ede9fe', dark: '#c4b5fd', darkTint: '#4c1d95' }, // violet
  { base: '#b91c1c', tint: '#fee2e2', dark: '#fca5a5', darkTint: '#7f1d1d' }, // red
  { base: '#0e7490', tint: '#cffafe', dark: '#67e8f9', darkTint: '#164e63' }, // cyan
  { base: '#4d7c0f', tint: '#ecfccb', dark: '#bef264', darkTint: '#365314' }, // lime
  { base: '#a21caf', tint: '#fae8ff', dark: '#f0abfc', darkTint: '#701a75' }, // fuchsia
  { base: '#334155', tint: '#e2e8f0', dark: '#cbd5e1', darkTint: '#1e293b' }, // slate
];

export function speakerColor(colorIndex: number): SpeakerColor {
  const n = SPEAKER_COLORS.length;
  const i = ((Math.trunc(colorIndex) % n) + n) % n;
  return SPEAKER_COLORS[i]!;
}

/** Default display name for the n-th (0-based) speaker. */
export function defaultSpeakerName(index: number): string {
  return `Speaker ${index + 1}`;
}

/**
 * Random id with a prefix, e.g. makeId("row") -> "row_k3j9x0a1b2c3".
 * Uses crypto.getRandomValues, which (unlike crypto.randomUUID) also works on
 * plain-HTTP origins in the browser.
 */
export function makeId(prefix: string): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return `${prefix}_${out}`;
}
