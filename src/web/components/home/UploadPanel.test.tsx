import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi, type Mock } from 'vitest';
import { getUsage, uploadTranscript } from '../../api';
import { UploadPanel } from './UploadPanel';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  getUsage: vi.fn(),
  uploadTranscript: vi.fn(),
}));
vi.mock('../../lib/audioAnalysis', () => ({
  readAudioDuration: vi.fn(async () => 12),
  decodeWaveform: vi.fn(async () => null),
}));

const upload = uploadTranscript as Mock<typeof uploadTranscript>;

beforeEach(() => {
  (getUsage as Mock<typeof getUsage>).mockReturnValue(new Promise(() => {}));
  // Stays "uploading" so the panel can be inspected mid-upload.
  upload.mockReturnValue({ promise: new Promise(() => {}), abort: vi.fn() });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:audio'), revokeObjectURL: vi.fn() });
});
afterEach(() => upload.mockReset());

async function startWith(language?: string) {
  render(
    <MemoryRouter>
      <UploadPanel />
    </MemoryRouter>,
  );
  const file = new File([new Uint8Array(100)], 'entrevue.mp3', { type: 'audio/mpeg' });
  fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
  if (language) await userEvent.selectOptions(screen.getByLabelText('Language'), language);
  await userEvent.click(screen.getByRole('button', { name: /Start transcription/ }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  return upload.mock.calls[0]![1];
}

describe('UploadPanel language', () => {
  it('detects the language unless one is chosen', async () => {
    expect(await startWith()).toMatchObject({ language: null });
  });

  it('uploads with the chosen language and shows it while uploading', async () => {
    expect(await startWith('French')).toMatchObject({ language: 'fr', quality: 'high' });
    expect(screen.getByText('French', { selector: '.badge' })).toBeInTheDocument();
  });
});
