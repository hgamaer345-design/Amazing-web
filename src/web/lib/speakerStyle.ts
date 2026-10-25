import type { CSSProperties } from 'react';
import { speakerColor } from '../../shared/speakers';

/**
 * CSS custom properties for a speaker's colour. Apply to any element and use
 * `var(--spk-fg)` / `var(--spk-bg)` in CSS; base.css switches them for dark mode.
 */
export function speakerStyleVars(colorIndex: number): CSSProperties {
  const c = speakerColor(colorIndex);
  return {
    '--spk-base': c.base,
    '--spk-tint': c.tint,
    '--spk-dark': c.dark,
    '--spk-dark-tint': c.darkTint,
  } as CSSProperties;
}
