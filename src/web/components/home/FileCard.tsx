import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { formatBytes, formatDuration, formatHms } from '../../../shared/time';
import type { Waveform } from '../../lib/audioAnalysis';
import { fileExtension } from '../../lib/fileValidation';
import { PauseIcon, PlayIcon } from '../editor/icons';

export interface FileCardProps {
  file: File;
  /** Object URL of the file, for the preview player. */
  url: string;
  durationSec: number | null;
  /** True while duration/waveform are being read. */
  analysing: boolean;
  waveform: Waveform | null;
  onRemove?: () => void;
}

function readCssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Bars of the waveform; the part already previewed is drawn in the accent colour. */
function WaveformCanvas({
  peaks,
  progress,
  onSeek,
}: {
  peaks: number[];
  progress: number;
  onSeek: (fraction: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const played = readCssVar(canvas, '--primary', '#1d4ed8');
    const rest = readCssVar(canvas, '--border-strong', '#c4cad3');
    const barWidth = width / peaks.length;
    peaks.forEach((p, i) => {
      const h = Math.max(2, p * (height - 4));
      ctx.fillStyle = (i + 0.5) / peaks.length <= progress ? played : rest;
      const x = i * barWidth;
      const w = Math.max(1, barWidth - Math.min(2, barWidth * 0.35));
      ctx.beginPath();
      ctx.roundRect(x, (height - h) / 2, w, h, Math.min(2, w / 2));
      ctx.fill();
    });
  }, [peaks, progress, width]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };

  return <canvas ref={canvasRef} className="waveform-canvas" onClick={onClick} aria-hidden="true" />;
}

/** The chosen file: icon, name, size, duration, waveform and a preview player. */
export function FileCard({ file, url, durationSec, analysing, waveform, onRemove }: FileCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [canPlay, setCanPlay] = useState(true);
  const total = durationSec ?? waveform?.durationSec ?? null;

  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setCanPlay(true);
  }, [url]);

  // requestAnimationFrame keeps the waveform progress smooth while previewing.
  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = () => {
      setTime(audioRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => setCanPlay(false));
    } else audio.pause();
  }, []);

  const seekTo = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !total) return;
    audio.currentTime = fraction * total;
    setTime(audio.currentTime);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!total) return;
    const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
    if (step === undefined || !audioRef.current) return;
    e.preventDefault();
    seekTo(Math.min(1, Math.max(0, (audioRef.current.currentTime + step) / total)));
  };

  const ext = fileExtension(file.name).toUpperCase() || 'AUDIO';
  const progress = total ? time / total : 0;

  return (
    <div className="file-card" data-testid="file-card">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setCanPlay(false)}
      />
      <div className="file-card-head">
        <span className="file-badge" aria-hidden="true">
          {ext}
        </span>
        <div className="file-card-info">
          <p className="file-name" title={file.name} dir="auto">
            {file.name}
          </p>
          <p className="file-meta">
            {formatBytes(file.size)}
            <span aria-hidden="true"> · </span>
            {analysing && total == null ? (
              <span className="file-meta-pending">reading duration…</span>
            ) : (
              <span data-testid="file-duration">
                {total != null ? formatDuration(total) : 'duration unknown'}
              </span>
            )}
          </p>
        </div>
        {onRemove && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="file-preview" onKeyDown={onKeyDown}>
        <button
          type="button"
          className="btn btn-primary btn-icon file-preview-play"
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          onClick={toggle}
          disabled={!canPlay}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="waveform">
          {waveform ? (
            <WaveformCanvas peaks={waveform.peaks} progress={progress} onSeek={seekTo} />
          ) : (
            <div className={`waveform-placeholder${analysing ? ' is-loading' : ''}`} aria-hidden="true">
              <span style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
        <span className="file-preview-time">
          {formatHms(time * 1000)}
          {total != null && <span className="file-preview-total"> / {formatHms(total * 1000)}</span>}
        </span>
      </div>
      {!canPlay && (
        <p className="field-hint">This browser can’t preview this file, but it can still be transcribed.</p>
      )}
    </div>
  );
}
