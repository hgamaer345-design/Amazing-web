import { useId } from 'react';
import type { QualityMode, QualityModeInfo, UsageResponse } from '../../../shared/types';
import { formatCountdown } from '../../lib/relativeTime';

export interface QualityPickerProps {
  modes: readonly QualityModeInfo[];
  value: QualityMode;
  onChange: (mode: QualityMode) => void;
  usage: UsageResponse | null;
  now: number;
  disabled?: boolean;
}

/** Remaining free uses today, or null when the mode is unlimited (or usage isn't known yet). */
export function remainingUses(mode: QualityModeInfo, usage: UsageResponse | null): number | null {
  if (mode.dailyLimit == null) return null;
  return usage?.modes[mode.id]?.remaining ?? mode.dailyLimit;
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <span className="quality-meter">
      <span className="quality-meter-label">{label}</span>
      <span className="quality-meter-bars" aria-label={`${label} ${value} of 5`} role="img">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={i <= value ? 'is-on' : undefined} />
        ))}
      </span>
    </span>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path
        d="M10 1.5l1.9 5.1 5.1 1.9-5.1 1.9L10 15.5l-1.9-5.1L3 8.5l5.1-1.9L10 1.5zM16 13l.8 2.2L19 16l-2.2.8L16 19l-.8-2.2L13 16l2.2-.8L16 13z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Three selectable cards (a native radio group, so arrow keys move the selection). */
export function QualityPicker({ modes, value, onChange, usage, now, disabled }: QualityPickerProps) {
  const name = useId();
  const selected = modes.find((m) => m.id === value) ?? modes[0];

  return (
    <fieldset className="quality" disabled={disabled}>
      <legend className="field-label">Quality</legend>
      <div className="quality-options">
        {modes.map((mode) => {
          const remaining = remainingUses(mode, usage);
          const exhausted = remaining === 0;
          const checked = mode.id === value;
          return (
            <label
              key={mode.id}
              className={`quality-card quality-${mode.id}${checked ? ' is-selected' : ''}${exhausted ? ' is-exhausted' : ''}`}
              data-testid={`quality-${mode.id}`}
            >
              <input
                type="radio"
                name={name}
                value={mode.id}
                checked={checked}
                disabled={exhausted}
                onChange={() => onChange(mode.id)}
                className="visually-hidden"
              />
              <span className="quality-card-top">
                <span className="quality-name">
                  {mode.id === 'ultra' && <SparkleIcon />}
                  {mode.label}
                </span>
                {mode.id === 'high' && <span className="badge badge-info">Recommended</span>}
                <span className="quality-check" aria-hidden="true" />
              </span>
              <span className="quality-tagline">{mode.tagline}</span>
              <span className="quality-meters">
                <Meter label="Speed" value={mode.speed} />
                <Meter label="Accuracy" value={mode.accuracy} />
              </span>
              {mode.dailyLimit != null && (
                <span
                  className={`quality-usage${exhausted ? ' is-exhausted' : ''}`}
                  data-testid={`quality-usage-${mode.id}`}
                >
                  {exhausted ? (
                    <>
                      Daily free limit reached
                      {usage && <> · resets in {formatCountdown(usage.resetsAt, now)}</>}
                    </>
                  ) : (
                    <>
                      {mode.dailyLimit} free per day · <strong>{remaining} left today</strong>
                    </>
                  )}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {selected && <p className="quality-description field-hint">{selected.description}</p>}
    </fieldset>
  );
}
