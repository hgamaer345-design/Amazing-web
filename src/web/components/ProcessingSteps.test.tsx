import { render, screen } from '@testing-library/react';
import type { TranscriptProgress } from '../../shared/types';
import ProcessingSteps, { stageAnnouncement } from './ProcessingSteps';

const progress = (message: string, etaSeconds: number | null = 90): TranscriptProgress => ({
  stage: 'transcribing',
  startedAt: null,
  elapsedSeconds: 30,
  etaSeconds,
  estimatedTotalSeconds: null,
  queuePosition: null,
  message,
  fraction: 0.4,
});

describe('ProcessingSteps', () => {
  it('announces the stage, not the counters that change on every poll', () => {
    expect(
      stageAnnouncement({
        stage: 'transcribing',
        progress: progress('Downloading Whisper Tiny speech model (3.1 MB of 41.6 MB) — only needed once…'),
      }),
    ).toBe('Downloading Whisper Tiny speech model…');
    expect(stageAnnouncement({ stage: 'transcribing', progress: progress('Finding the speakers…') })).toBe(
      'Finding the speakers…',
    );
    expect(stageAnnouncement({ stage: 'transcribing' })).toBe('Transcribing…');
  });

  it('shows the detail and ETA visually while the live region stays stable', () => {
    render(<ProcessingSteps stage="transcribing" progress={progress('Transcribing…', 75)} />);
    expect(
      screen.getByText(/Transcribing… · about 1 minute remaining|Transcribing… · 1 min/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^Transcribing…$/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });
});
