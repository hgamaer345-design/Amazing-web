import { memo, useMemo, type MouseEvent } from 'react';
import { formatHms } from '../../../shared/time';
import type { Speaker, TranscriptRow } from '../../../shared/types';
import { usePlaybackTime, type TimeStore } from '../../hooks/useAudioPlayer';
import { speakerStyleVars } from '../../lib/speakerStyle';

export interface SpeakerTimelineProps {
  rows: readonly TranscriptRow[];
  speakers: readonly Speaker[];
  durationMs: number | null;
  time: TimeStore;
  /** Absent when there is no audio to seek. */
  onSeek?: (ms: number) => void;
}

const Playhead = memo(function Playhead({ time, durationMs }: { time: TimeStore; durationMs: number }) {
  const current = usePlaybackTime(time);
  return (
    <span className="spk-timeline-head" style={{ left: `${Math.min(100, (current / durationMs) * 100)}%` }} />
  );
});

/**
 * Who speaks when: one coloured block per row across the whole recording, with a playhead.
 * Clicking jumps the audio there. It's a pointer shortcut; the seek bar is the accessible control.
 */
export const SpeakerTimeline = memo(function SpeakerTimeline({
  rows,
  speakers,
  durationMs,
  time,
  onSeek,
}: SpeakerTimelineProps) {
  const total = Math.max(durationMs ?? 0, rows[rows.length - 1]?.endMs ?? 0);
  const colorById = useMemo(() => new Map(speakers.map((s) => [s.id, s])), [speakers]);
  const blocks = useMemo(
    () =>
      total > 0
        ? rows.map((r) => {
            const speaker = colorById.get(r.speakerId);
            return {
              id: r.id,
              left: (r.startMs / total) * 100,
              width: Math.max(0.15, ((r.endMs - r.startMs) / total) * 100),
              style: speakerStyleVars(speaker?.colorIndex ?? 9),
              title: `${speaker?.name ?? 'Unknown speaker'} · ${formatHms(r.startMs)}`,
            };
          })
        : [],
    [rows, colorById, total],
  );
  if (total <= 0) return null;

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(Math.round(fraction * total));
  };

  return (
    <div
      className="spk-timeline"
      aria-hidden="true"
      onClick={onClick}
      style={onSeek ? undefined : { cursor: 'default' }}
      data-testid="speaker-timeline"
    >
      {blocks.map((b) => (
        <span
          key={b.id}
          className="spk-timeline-block"
          title={b.title}
          style={{ ...b.style, left: `${b.left}%`, width: `${b.width}%` }}
        />
      ))}
      <Playhead time={time} durationMs={total} />
    </div>
  );
});
