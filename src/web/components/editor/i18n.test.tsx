// Text in any language and script: the transcript, its title and speaker names carry their own
// language and writing direction, while the interface (and the table layout) stays English, left to right.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { saveDocumentRequestSchema } from '../../../shared/document';
import type { Speaker, TranscriptDetail, TranscriptRow } from '../../../shared/types';
import { EditableTitle } from './EditableTitle';
import { RowTextEditor } from './RowTextEditor';
import { SpeakerLegend } from './SpeakerLegend';
import { TranscriptEditor } from './TranscriptEditor';
import { TranscriptRowView, type RowActions } from './TranscriptRowView';

const noop = () => {};
const actions: RowActions = {
  playFrom: noop,
  editText: noop,
  merge: noop,
  reassign: noop,
  reassignNew: noop,
  renameSpeaker: noop,
};
const speaker: Speaker = { id: 'a', name: 'المحاور', colorIndex: 0 };

function renderRow(row: Partial<TranscriptRow>, defaultLang?: string | null) {
  return render(
    <table>
      <tbody>
        <TranscriptRowView
          row={{ id: 'r', speakerId: 'a', startMs: 0, endMs: 1000, text: 'مرحبا، كيف حالك؟', ...row }}
          index={0}
          speaker={speaker}
          speakers={[speaker]}
          isActive={false}
          isFirst
          isLast
          actions={actions}
          defaultLang={defaultLang}
        />
      </tbody>
    </table>,
  );
}

describe('transcript rows', () => {
  it("mark the text with the transcript's language and direction, not the table", () => {
    const { container } = renderRow({}, 'ar');
    const p = container.querySelector('.tx-text')!;
    expect(p.textContent).toBe('مرحبا، كيف حالك؟');
    expect(p).toHaveAttribute('lang', 'ar');
    expect(p).toHaveAttribute('dir', 'rtl');
    expect(container.querySelector('tr')).not.toHaveAttribute('dir');
    // The interface itself stays English; the text overrides that where it appears.
    expect(readFileSync('src/web/index.html', 'utf8')).toContain('<html lang="en">');
  });

  it("prefer the row's own language", () => {
    const { container } = renderRow({ text: 'Bonjour à tous', lang: 'fr' }, 'ar');
    expect(container.querySelector('.tx-text')).toHaveAttribute('lang', 'fr');
    expect(container.querySelector('.tx-text')).toHaveAttribute('dir', 'auto');
  });

  it('take the direction from the text when the language is unknown', () => {
    const { container } = renderRow({}, null);
    const p = container.querySelector('.tx-text')!;
    expect(p).not.toHaveAttribute('lang');
    expect(p).toHaveAttribute('dir', 'auto');
  });

  it('keep the "No text" placeholder in English', () => {
    const { container } = renderRow({ text: '' }, 'ar');
    expect(container.querySelector('.tx-text')).not.toHaveAttribute('lang');
  });

  it('edit the text in its language and direction', () => {
    renderRow({ text: 'שלום, מה שלומך?' }, 'he');
    fireEvent.click(screen.getByRole('button', { name: 'Edit text of row 1' }));
    const textarea = screen.getByLabelText('Text of row 1');
    expect(textarea).toHaveAttribute('lang', 'he');
    expect(textarea).toHaveAttribute('dir', 'rtl');
  });

  it('give speaker names their own direction', () => {
    const { container } = renderRow({}, 'ar');
    expect(container.querySelector('.spk-chip-name')).toHaveAttribute('dir', 'auto');
  });
});

describe('row text editor', () => {
  it('lets the text set its direction when its language is unknown', () => {
    render(
      <RowTextEditor initialText="שלום, מה שלומך?" label="Text of row 1" onCommit={noop} onCancel={noop} />,
    );
    expect(screen.getByLabelText('Text of row 1')).toHaveAttribute('dir', 'auto');
  });

  it('does not save on the Enter that confirms an IME candidate', () => {
    const onCommit = vi.fn();
    render(
      <RowTextEditor initialText="にほんご" label="Text" lang="ja" onCommit={onCommit} onCancel={noop} />,
    );
    const textarea = screen.getByLabelText('Text');
    // Safari: composition already ended, but the key is still reported as IME input.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    expect(onCommit).toHaveBeenCalledWith('にほんご', true);
  });
});

describe('titles and speaker names', () => {
  it('let the title and the legend chips take their direction from their text', () => {
    render(<EditableTitle title="مقابلة مع المدير" onSave={async () => {}} />);
    expect(screen.getByRole('heading', { name: 'مقابلة مع المدير' })).toHaveAttribute('dir', 'auto');
    const { container } = render(
      <SpeakerLegend speakers={[speaker]} rowCounts={new Map([['a', 1]])} onRename={noop} />,
    );
    expect(container.querySelector('.spk-chip-name')).toHaveAttribute('dir', 'auto');
  });
});

describe('per-row languages', () => {
  it('survive saving', () => {
    const parsed = saveDocumentRequestSchema.parse({
      baseVersion: 1,
      speakers: [{ id: 'a', name: 'A', colorIndex: 0 }],
      rows: [{ id: 'r', speakerId: 'a', startMs: 0, endMs: 1, text: 'hola', lang: 'es' }],
    });
    expect(parsed.rows[0]).toHaveProperty('lang', 'es');
  });
});

describe('transcript header', () => {
  const speakers: Speaker[] = [
    { id: 'a', name: 'Speaker 1', colorIndex: 0 },
    { id: 'b', name: 'Speaker 2', colorIndex: 1 },
  ];
  const rows: TranscriptRow[] = [
    { id: 'r1', speakerId: 'a', startMs: 0, endMs: 6000, text: 'Hello, welcome.' },
    { id: 'r2', speakerId: 'b', startMs: 6000, endMs: 9000, text: 'Bonjour, merci.', lang: 'fr' },
  ];

  function renderEditor(overrides: Partial<TranscriptDetail>, docRows = rows) {
    const transcript: TranscriptDetail = {
      id: 't1',
      title: 'Interview',
      originalFilename: 'interview.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 1000,
      durationSec: 9,
      status: 'done',
      provider: 'mock',
      quality: 'high',
      languageCode: 'en',
      requestedLanguage: null,
      speakersExpected: null,
      speakerCount: 2,
      rowCount: docRows.length,
      keepAudio: false,
      audioAvailable: false,
      error: null,
      createdAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-01T10:00:00Z',
      completedAt: '2026-01-01T10:01:00Z',
      progress: {
        stage: 'done',
        startedAt: null,
        elapsedSeconds: 0,
        etaSeconds: 0,
        estimatedTotalSeconds: null,
        queuePosition: null,
      },
      document: { version: 1, speakers, rows: docRows },
      ...overrides,
    };
    return render(
      <MemoryRouter>
        <TranscriptEditor transcript={transcript} document={transcript.document!} onSummaryChange={noop} />
      </MemoryRouter>,
    );
  }

  it('lists every language spoken, most spoken first', () => {
    const { container } = renderEditor({});
    expect(screen.getByTestId('transcript-languages')).toHaveTextContent('LanguagesEnglish, French');
    const texts = container.querySelectorAll('.tx-text');
    expect(texts[0]).toHaveAttribute('lang', 'en');
    expect(texts[1]).toHaveAttribute('lang', 'fr');
  });

  it('shows a single detected language', () => {
    renderEditor({}, [rows[0]!]);
    expect(screen.getByTestId('transcript-languages')).toHaveTextContent(/^LanguageEnglish$/);
    expect(screen.queryByTestId('transcript-requested-language')).toBeNull();
  });

  it('says when the language was chosen at upload', () => {
    renderEditor({ languageCode: 'fr', requestedLanguage: 'fr' }, [{ ...rows[1]!, lang: undefined }]);
    expect(screen.getByTestId('transcript-languages')).toHaveTextContent('LanguageFrench (chosen)');
  });

  it('shows the chosen language separately when the transcript says otherwise', () => {
    renderEditor({ requestedLanguage: 'de' });
    expect(screen.getByTestId('transcript-languages')).toHaveTextContent('LanguagesEnglish, French');
    const chosen = screen.getByTestId('transcript-requested-language');
    expect(within(chosen).getByText('German')).toBeInTheDocument();
  });
});
