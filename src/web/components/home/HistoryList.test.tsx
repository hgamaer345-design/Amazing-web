import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, type Mock } from 'vitest';
import type { TranscriptSummary } from '../../../shared/types';
import { listTranscripts } from '../../api';
import { HistoryList } from './HistoryList';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  listTranscripts: vi.fn(),
}));

const summary = (overrides: Partial<TranscriptSummary>): TranscriptSummary => ({
  id: 't',
  title: 'Recording',
  originalFilename: 'recording.mp3',
  mimeType: 'audio/mpeg',
  sizeBytes: 1000,
  durationSec: 60,
  status: 'done',
  provider: 'mock',
  quality: 'high',
  languageCode: null,
  requestedLanguage: null,
  speakersExpected: null,
  speakerCount: 2,
  rowCount: 4,
  keepAudio: false,
  audioAvailable: false,
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  ...overrides,
});

describe('HistoryList', () => {
  it('shows each transcript’s language, and titles in their own direction', async () => {
    (listTranscripts as Mock<typeof listTranscripts>).mockResolvedValue([
      summary({ id: 'a', title: 'مقابلة', languageCode: 'ar' }),
      summary({ id: 'b', title: 'Queued', status: 'queued', requestedLanguage: 'ja', speakerCount: null }),
      summary({ id: 'c', title: 'Unknown' }),
    ]);
    render(
      <MemoryRouter>
        <HistoryList />
      </MemoryRouter>,
    );
    const items = await screen.findAllByTestId('history-item');
    const meta = items.map((li) => li.querySelector('.history-meta')!.textContent);
    expect(meta[0]).toMatch(/^1m 0s · 2 speakers · Arabic · /);
    expect(meta[1]).toMatch(/^1m 0s · Japanese · /);
    expect(meta[2]).toMatch(/^1m 0s · 2 speakers · [^·]+$/);
    expect(screen.getByText('مقابلة')).toHaveAttribute('dir', 'auto');
  });
});
