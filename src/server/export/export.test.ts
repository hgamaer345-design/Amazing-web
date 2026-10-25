import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { speakerColor } from '../../shared/speakers';
import type { TranscriptDocument } from '../../shared/types';
import { buildExportRows, languageLabel, sanitizeText } from '../../shared/export/common';
import { toCsv } from '../../shared/export/csv';
import { exportTranscript, type ExportInput } from './index';
import { SRT_LIMITS, toSrt, wrapCueText } from '../../shared/export/srt';
import { toTxt } from '../../shared/export/txt';
import { XLSX_MAX_CELL_CHARS } from '../../shared/export/xlsx';

const doc: TranscriptDocument = {
  version: 3,
  speakers: [
    { id: 'spk_1', name: 'Interviewer', colorIndex: 0 },
    { id: 'spk_2', name: 'Guest, "Dr." Ana', colorIndex: 1 },
  ],
  rows: [
    { id: 'r1', speakerId: 'spk_1', startMs: 0, endMs: 4_200, text: 'Welcome to the show. How are you?' },
    { id: 'r2', speakerId: 'spk_2', startMs: 4_500, endMs: 9_999, text: 'Great, thanks!\nReally "great".' },
    { id: 'r3', speakerId: 'spk_1', startMs: 3_661_000, endMs: 3_662_500, text: '=SUM(A1) & <b>bold</b>' },
  ],
};

const input: ExportInput = {
  title: 'Interview — Ünïcode',
  originalFilename: 'interview.mp3',
  createdAt: '2026-01-31T14:05:00.000Z',
  durationSec: 3725,
  languageCode: 'en',
  document: doc,
};

function srtCues(srt: string) {
  return srt
    .trim()
    .split('\r\n\r\n')
    .map((block) => {
      const [num, timing, ...lines] = block.split('\r\n');
      const [start, end] = timing!.split(' --> ').map((t) => {
        const [h, m, rest] = t.split(':');
        const [s, ms] = rest!.split(',');
        return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
      });
      return { num: Number(num), start: start!, end: end!, lines };
    });
}

describe('common helpers', () => {
  it('resolves speaker names, numbers rows and formats times', () => {
    const rows = buildExportRows({
      ...doc,
      rows: [...doc.rows, { id: 'r4', speakerId: 'gone', startMs: 1, endMs: 2, text: 'x' }],
    });
    expect(rows.map((r) => [r.number, r.speakerName, r.start, r.end])).toEqual([
      [1, 'Interviewer', '00:00:00', '00:00:04'],
      [2, 'Guest, "Dr." Ana', '00:00:04', '00:00:09'],
      [3, 'Interviewer', '01:01:01', '01:01:02'],
      [4, 'Unknown speaker', '00:00:00', '00:00:00'],
    ]);
    expect(rows[3]!.colorIndex).toBeNull();
  });

  it('strips characters that are invalid in XML and normalises newlines', () => {
    expect(sanitizeText('a\u0000b\u0007c\r\nd\re\uD800f')).toBe('abc\nd\nef');
    expect(sanitizeText('emoji 😀 ok')).toBe('emoji 😀 ok');
  });

  it('labels languages', () => {
    expect(languageLabel('en')).toBe('English (en)');
    expect(languageLabel('es')).toBe('Spanish (es)');
    expect(languageLabel('en_us')).toBe('American English (en_us)');
    expect(languageLabel(null)).toBe('Unknown');
    expect(languageLabel('not a code!')).toBe('not a code!');
  });
});

describe('CSV', () => {
  it('writes RFC 4180 CSV with BOM, CRLF and a formula guard', () => {
    const csv = toCsv(buildExportRows(doc));
    expect(csv).toBe(
      '﻿#,Speaker,Start,End,Text\r\n' +
        '1,Interviewer,00:00:00,00:00:04,Welcome to the show. How are you?\r\n' +
        '2,"Guest, ""Dr."" Ana",00:00:04,00:00:09,"Great, thanks!\nReally ""great""."\r\n' +
        "3,Interviewer,01:01:01,01:01:02,'=SUM(A1) & <b>bold</b>\r\n",
    );
  });

  it('guards every formula trigger character and keeps unicode', () => {
    const rows = buildExportRows({
      version: 1,
      speakers: [{ id: 's', name: '@admin', colorIndex: 0 }],
      rows: ['+1', '-2', '@x', '\tt', 'héllo 世界'].map((text, i) => ({
        id: `r${i}`,
        speakerId: 's',
        startMs: i,
        endMs: i,
        text,
      })),
    });
    const lines = toCsv(rows).slice(1).split('\r\n');
    expect(lines.slice(1, 6)).toEqual([
      "1,'@admin,00:00:00,00:00:00,'+1",
      "2,'@admin,00:00:00,00:00:00,'-2",
      "3,'@admin,00:00:00,00:00:00,'@x",
      "4,'@admin,00:00:00,00:00:00,'\tt",
      "5,'@admin,00:00:00,00:00:00,héllo 世界",
    ]);
  });
});

describe('TXT', () => {
  it('writes "Speaker: text" blocks separated by blank lines and skips empty rows', () => {
    const txt = toTxt(
      buildExportRows({
        ...doc,
        rows: [
          ...doc.rows.slice(0, 2),
          { id: 'e', speakerId: 'spk_1', startMs: 10_000, endMs: 10_000, text: '  ' },
        ],
      }),
    );
    expect(txt).toBe(
      'Interviewer: Welcome to the show. How are you?\n\nGuest, "Dr." Ana: Great, thanks!\nReally "great".\n',
    );
    expect(toTxt([])).toBe('');
  });
});

describe('SRT', () => {
  it('numbers cues, formats timestamps and prefixes the speaker', () => {
    const srt = toSrt(buildExportRows(doc));
    expect(
      srt.startsWith(
        '1\r\n00:00:00,000 --> 00:00:04,200\r\nInterviewer: Welcome to the show. How are\r\nyou?\r\n',
      ),
    ).toBe(true);
    const cues = srtCues(srt);
    expect(cues.map((c) => c.num)).toEqual(cues.map((_, i) => i + 1));
    expect(cues.at(-1)!.lines.join(' ')).toBe('Interviewer: =SUM(A1) & <b>bold</b>');
  });

  it('splits long rows at sentence boundaries with proportional, non-overlapping timing', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of the answer.`);
    const rows = buildExportRows({
      version: 1,
      speakers: [{ id: 's', name: 'Speaker 1', colorIndex: 0 }],
      rows: [
        { id: 'a', speakerId: 's', startMs: 10_000, endMs: 70_000, text: sentences.join(' ') },
        { id: 'b', speakerId: 's', startMs: 70_000, endMs: 72_000, text: 'Next.' },
      ],
    });
    const cues = srtCues(toSrt(rows));
    expect(cues.length).toBeGreaterThan(6);
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i]!;
      expect(c.end).toBeGreaterThan(c.start);
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
      expect(c.lines.length).toBeLessThanOrEqual(SRT_LIMITS.maxLines);
      for (const line of c.lines) expect(line.length).toBeLessThanOrEqual(SRT_LIMITS.charsPerLine + 18);
      expect(c.lines[0]!.startsWith('Speaker 1: ')).toBe(true);
    }
    const rowCues = cues.slice(0, -1);
    expect(rowCues[0]!.start).toBe(10_000);
    expect(rowCues.at(-1)!.end).toBe(70_000);
    // Each cue ends on a sentence boundary.
    for (const c of rowCues) expect(c.lines.join(' ')).toMatch(/\.$/);
    expect(cues.at(-1)).toMatchObject({ start: 70_000, end: 72_000 });
  });

  it('handles zero-length rows, overlapping rows, empty rows and very long words', () => {
    const longWord = 'x'.repeat(130);
    const rows = buildExportRows({
      version: 1,
      speakers: [
        { id: 'a', name: 'A', colorIndex: 0 },
        { id: 'b', name: 'B', colorIndex: 1 },
      ],
      rows: [
        { id: '1', speakerId: 'a', startMs: 1000, endMs: 1000, text: 'Zero length.' },
        { id: '2', speakerId: 'b', startMs: 1200, endMs: 3000, text: 'Overlapping start.' },
        { id: '3', speakerId: 'a', startMs: 1200, endMs: 1500, text: 'Same start.' },
        { id: '4', speakerId: 'b', startMs: 5000, endMs: 6000, text: '   ' },
        { id: '5', speakerId: 'b', startMs: 8000, endMs: 20_000, text: longWord },
      ],
    });
    const cues = srtCues(toSrt(rows));
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i]!.end).toBeGreaterThan(cues[i]!.start);
      if (i > 0) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
    }
    expect(cues.some((c) => c.lines.join('').includes('   '))).toBe(false);
    expect(
      cues
        .filter((c) => c.lines.join('').includes('xxx'))
        .map((c) => c.lines.join(''))
        .join(''),
    ).toContain(longWord.slice(0, 40));
    expect(cues[0]).toMatchObject({ start: 1000, end: 1200 });
  });

  it('keeps cues of short rows readable rather than splitting them into flashes', () => {
    const rows = buildExportRows({
      version: 1,
      speakers: [{ id: 's', name: 'S', colorIndex: 0 }],
      rows: [
        { id: 'a', speakerId: 's', startMs: 0, endMs: 900, text: 'One. Two. Three. Four. Five. Six. Seven.' },
      ],
    });
    const cues = srtCues(toSrt(rows));
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start: 0, end: 900 });
  });

  it('wraps cue text to two lines where possible', () => {
    expect(wrapCueText('short')).toEqual(['short']);
    const lines = wrapCueText(
      'Speaker 1: a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee',
    );
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty file for a transcript with no text', () => {
    expect(toSrt([])).toBe('');
  });
});

describe('XLSX', () => {
  it('writes a transcript sheet and an info sheet', async () => {
    const out = await exportTranscript('xlsx', input);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Transcript')!;
    expect(ws.getRow(1).values).toEqual([undefined, '#', 'Speaker', 'Start', 'End', 'Text']);
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.getRow(2).values).toEqual([
      undefined,
      1,
      'Interviewer',
      '00:00:00',
      '00:00:04',
      'Welcome to the show. How are you?',
    ]);
    expect(ws.getCell('E4').value).toBe('=SUM(A1) & <b>bold</b>');
    expect(ws.getCell('B3').font?.color?.argb).toBe(`FF${speakerColor(1).base.slice(1).toUpperCase()}`);
    expect(ws.getCell('E3').alignment?.wrapText).toBe(true);
    const infoSheet = wb.getWorksheet('Info')!;
    const info = Object.fromEntries(
      infoSheet
        .getSheetValues()
        .filter(Boolean)
        .map((v) => [(v as unknown[])[1], (v as unknown[])[2]]),
    );
    expect(info).toMatchObject({
      Title: 'Interview — Ünïcode',
      'Original file': 'interview.mp3',
      Created: '2026-01-31 14:05 UTC',
      Duration: '1h 2m 5s',
      Language: 'English (en)',
      Speakers: 'Interviewer, Guest, "Dr." Ana',
    });
  });

  it('continues over-long text on extra rows instead of exceeding the Excel cell limit', async () => {
    const long = 'word '.repeat(10_000).trim();
    const out = await exportTranscript('xlsx', {
      ...input,
      document: { ...doc, rows: [{ id: 'x', speakerId: 'spk_1', startMs: 0, endMs: 1000, text: long }] },
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Transcript')!;
    expect(ws.rowCount).toBe(3);
    const texts = [ws.getCell('E2').value as string, ws.getCell('E3').value as string];
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(XLSX_MAX_CELL_CHARS);
    expect(texts.join(' ')).toBe(long);
    expect(ws.getCell('A3').value).toBe(1);
  });
});

describe('DOCX', () => {
  it('writes a document with a title, metadata and a table with a repeated header', async () => {
    const out = await exportTranscript('docx', input);
    const zip = await JSZip.loadAsync(out.body);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Interview — Ünïcode');
    expect(xml).toContain('File: interview.mp3');
    expect(xml).toContain('Language: English (en)');
    expect(xml).toContain('Guest, &quot;Dr.&quot; Ana');
    expect(xml).toContain('01:01:01');
    expect(xml).toContain('=SUM(A1) &amp; &lt;b&gt;bold&lt;/b&gt;');
    expect(xml).toContain('<w:tblHeader');
    expect(xml).toContain(speakerColor(0).base.slice(1).toUpperCase());
    // The line break inside row 2 is kept.
    expect(xml).toMatch(/Great, thanks!<\/w:t>.*<w:br\/>.*Really/s);
  });
});

describe('exportTranscript', () => {
  it.each([
    ['csv', 'text/csv; charset=utf-8'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['txt', 'text/plain; charset=utf-8'],
    ['srt', 'application/x-subrip; charset=utf-8'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ] as const)('%s has the right content type and extension', async (format, contentType) => {
    const out = await exportTranscript(format, input);
    expect(out.contentType).toBe(contentType);
    expect(out.fileExtension).toBe(format);
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect(out.body.length).toBeGreaterThan(0);
  });

  it('handles a large transcript quickly', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `r${i}`,
      speakerId: i % 2 ? 'spk_1' : 'spk_2',
      startMs: i * 4000,
      endMs: i * 4000 + 3500,
      text: `Sentence ${i} is here. And another one follows it for good measure.`,
    }));
    const big = { ...input, document: { ...doc, rows } };
    const started = Date.now();
    await Promise.all((['csv', 'xlsx', 'txt', 'srt', 'docx'] as const).map((f) => exportTranscript(f, big)));
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
