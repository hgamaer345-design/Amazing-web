import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { formatHms } from '../../../shared/time';
import { ACCEPTED_EXTENSIONS } from '../../../shared/types';
import { PLAYBACK_RATES, usePlaybackTime, type AudioPlayer as Player, type TimeStore } from '../../hooks/useAudioPlayer';
import { AttachIcon, BackIcon, ForwardIcon, PauseIcon, PlayIcon } from './icons';

const ACCEPT = [...ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`), 'audio/*'].join(',');
const SKIP_MS = 5_000;

export type AudioSourceKind = 'session' | 'server' | 'local';

export interface AudioSource {
  kind: AudioSourceKind;
  url: string;
  /** File name for a locally attached file. */
  fileName?: string;
}

export interface AudioPlayerProps {
  player: Player;
  source: AudioSource | null;
  /** Why the last source failed, if one did. */
  error: string | null;
  followAlong: boolean;
  onFollowAlongChange: (value: boolean) => void;
  onAttachFile: (file: File) => void;
}

function AttachAudioButton({ label, onFile }: { label: string; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
        <AttachIcon />
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label="Audio file to attach"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so choosing the same file again still fires a change event.
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}

function PlayerClock({ time, durationMs }: { time: TimeStore; durationMs: number | null }) {
  const current = usePlaybackTime(time);
  return (
    <span className="player-clock">
      <span>{formatHms(current)}</span>
      <span className="player-clock-sep" aria-hidden="true">
        /
      </span>
      <span className="visually-hidden"> of </span>
      <span>{durationMs != null ? formatHms(durationMs) : '--:--:--'}</span>
    </span>
  );
}

function SeekBar({ player }: { player: Player }) {
  const current = usePlaybackTime(player.time);
  const max = player.durationMs ?? 0;
  const value = Math.min(current, max);
  const progress = max > 0 ? (value / max) * 100 : 0;

  // Native arrow steps on a long recording are either tiny or huge; use the same 5 s as the skip buttons.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const delta = { ArrowLeft: -SKIP_MS, ArrowDown: -SKIP_MS, ArrowRight: SKIP_MS, ArrowUp: SKIP_MS }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    player.skip(delta);
  };

  return (
    <input
      type="range"
      className="player-seek"
      min={0}
      max={Math.max(max, 1)}
      step={100}
      value={value}
      disabled={max <= 0}
      aria-label="Seek"
      aria-valuetext={`${formatHms(value)} of ${formatHms(max)}`}
      style={{ '--progress': `${progress}%` } as CSSProperties}
      onChange={(e) => player.seek(Number(e.target.value))}
      onKeyDown={onKeyDown}
    />
  );
}

/** Sticky audio bar: play/pause, ±5 s, seek, time, speed and "Follow along"; or a notice to attach a file. */
export function AudioPlayer({ player, source, error, followAlong, onFollowAlongChange, onAttachFile }: AudioPlayerProps) {
  const failed = player.status === 'error';

  return (
    <section className="player" aria-label="Audio player">
      <audio ref={player.audioRef} src={source?.url} preload="metadata" />
      {!source ? (
        <div className="player-notice">
          <div className="player-notice-text">
            {error ? (
              <>
                <strong>The audio couldn’t be played.</strong> {error}
              </>
            ) : (
              <>
                <strong>Audio was deleted from the server after processing.</strong> Attach the original file to
                play it along with the transcript. It stays on this device.
              </>
            )}
          </div>
          <AttachAudioButton label="Attach audio file" onFile={onAttachFile} />
        </div>
      ) : (
        <>
          <div className="player-controls">
            <div className="player-buttons">
              <button
                type="button"
                className="btn btn-primary btn-icon player-play"
                aria-label={player.playing ? 'Pause' : 'Play'}
                aria-keyshortcuts="Space"
                disabled={failed}
                onClick={player.toggle}
              >
                {player.playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Back 5 seconds"
                title="Back 5 seconds"
                disabled={failed}
                onClick={() => player.skip(-SKIP_MS)}
              >
                <BackIcon />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Forward 5 seconds"
                title="Forward 5 seconds"
                disabled={failed}
                onClick={() => player.skip(SKIP_MS)}
              >
                <ForwardIcon />
              </button>
              <PlayerClock time={player.time} durationMs={player.durationMs} />
              {player.status === 'loading' && <span className="spinner player-loading" aria-hidden="true" />}
            </div>
            <SeekBar player={player} />
            <div className="player-options">
              <select
                className="select player-rate"
                aria-label="Playback speed"
                value={player.rate}
                onChange={(e) => player.setRate(Number(e.target.value))}
              >
                {PLAYBACK_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
              <label className="checkbox player-follow">
                <input
                  type="checkbox"
                  checked={followAlong}
                  onChange={(e) => onFollowAlongChange(e.target.checked)}
                />
                Follow along
              </label>
            </div>
          </div>
          {source.kind === 'local' && (
            <div className="player-source">
              <span>
                Playing your local file <strong>{source.fileName}</strong>.
              </span>
              <AttachAudioButton label="Choose another file" onFile={onAttachFile} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
