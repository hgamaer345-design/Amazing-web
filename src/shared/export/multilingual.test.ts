import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { TranscriptDocument } from '../types';
import { buildExportRows, exportLanguages, isRtlText, RLM } from './common';
import { renderExport, type ExportInput } from './render';
import { SRT_LIMITS, textWidth, toSrt } from './srt';
import { toTxt } from './txt';

const doc1 = (text: string, endMs = 9000, lang?: string): TranscriptDocument => ({
  version: 1,
  speakers: [{ id: 'a', name: 'Speaker 1', colorIndex: 0 }],
  rows: [{ id: 'r', speakerId: 'a', startMs: 0, endMs, text, ...(lang ? { lang } : {}) }],
});
const srtOf = (text: string, endMs = 9000, lang?: string) => toSrt(buildExportRows(doc1(text, endMs, lang)));
const cueLines = (srt: string) =>
  srt
    .trim()
    .split('\r\n\r\n')
    .map((b) => b.split('\r\n').slice(2));
const cueTexts = (srt: string) => cueLines(srt).map((lines) => lines.join('\n'));
/** Direction of a line as viewers decide it: by its first strong character (marks included). */
const firstStrong = (s: string) => {
  const m = /[\p{L}\u200E\u200F]/u.exec(s);
  return m && /[\u200F\p{Script=Arabic}\p{Script=Hebrew}]/u.test(m[0]) ? 'rtl' : 'ltr';
};

const input = (document: TranscriptDocument, languageCode: string | null): ExportInput => ({
  title: 't',
  originalFilename: 'a.mp3',
  createdAt: '2026-01-01T00:00:00Z',
  durationSec: 30,
  languageCode,
  document,
});
const mixed: TranscriptDocument = {
  version: 1,
  speakers: [
    { id: 'a', name: 'Speaker 1', colorIndex: 0 },
    { id: 'b', name: 'المحاور', colorIndex: 1 },
  ],
  rows: [
    ['a', 'مرحبا، كيف حالك اليوم؟ لدي 3 أسئلة عن iPhone 15.', 'ar'],
    ['b', '今日は「直」と「骨」の字を確認します。', 'ja'],
    ['a', '今天我们来讨论一下人工智能。', 'zh'],
    ['b', 'नमस्ते, आप कैसे हैं?', 'hi'],
    ['a', 'Bonjour, je vais bien.', 'fr'],
    ['b', 'Hello.', undefined],
  ].map(([speakerId, text, lang], i) => ({
    id: `r${i}`,
    speakerId: speakerId!,
    startMs: i * 4000,
    endMs: i * 4000 + 3500,
    text: text!,
    ...(lang ? { lang } : {}),
  })),
};

async function docxXml(document: TranscriptDocument, languageCode: string | null) {
  const zip = await JSZip.loadAsync((await renderExport('docx', input(document, languageCode))).bytes);
  return {
    body: await zip.file('word/document.xml')!.async('string'),
    styles: await zip.file('word/styles.xml')!.async('string'),
  };
}
/** The XML of the table cell holding `text`. */
const cellOf = (body: string, text: string) =>
  body
    .split('<w:tc>')
    .slice(1)
    .find((c) => c.includes(text)) ?? '';

describe('export rows', () => {
  it('carry the row’s language, else the transcript’s', () => {
    expect(buildExportRows(mixed, 'ar').map((r) => r.lang)).toEqual(['ar', 'ja', 'zh', 'hi', 'fr', 'ar']);
    expect(buildExportRows(doc1('x')).map((r) => r.lang)).toEqual([null]);
    expect(exportLanguages(buildExportRows(mixed, 'fr'), 'fr')).toEqual(['fr', 'ar', 'ja', 'zh', 'hi']);
  });

  it('read right to left when most of their letters do', () => {
    expect(isRtlText('مرحبا، كيف حالك؟', null)).toBe(true);
    expect(isRtlText('iPhone 15 هو أفضل هاتف عندي الآن', 'ar')).toBe(true);
    expect(isRtlText('I met المحاور yesterday', 'ar')).toBe(false);
    expect(isRtlText('123', 'he')).toBe(true);
    expect(isRtlText('123', 'en')).toBe(false);
  });
});

describe('SRT in other scripts', () => {
  it('packs Chinese sentences into one cue without spaces', () => {
    expect(cueTexts(srtOf('好的。谢谢。再见。', 3000))).toEqual(['Speaker 1: 好的。谢谢。再见。']);
  });

  it('counts Chinese, Japanese and Korean characters as two columns', () => {
    expect(textWidth('今日は')).toBe(6);
    expect(textWidth('한국어')).toBe(6);
    expect(textWidth('ｱｲｳ')).toBe(3);
    expect(textWidth('नमस्ते')).toBe(4); // न म स त: the virama and the vowel sign take no room
    const zh = '首先我想说的是，这个领域在过去十年里发生了巨大的变化。';
    const [lines] = cueLines(srtOf(zh, 4000));
    expect(lines).toEqual(['Speaker 1: 首先我想说的是，这个领域在过去', '十年里发生了巨大的变化。']);
    for (const line of lines!) expect(textWidth(line)).toBeLessThanOrEqual(SRT_LIMITS.charsPerLine);
  });

  it('breaks text without spaces between words, never before closing punctuation', () => {
    const ja = '今日は「直」と「骨」の字を確認します。それから、東京の話をしましょう。いいですね。'.repeat(2);
    const lines = cueLines(srtOf(ja, 12000)).flat();
    expect(lines.join('').replace(/Speaker 1: /g, '')).toBe(ja);
    for (const line of lines) expect(line).not.toMatch(/^[。、」）]/);
    expect(lines.some((l) => /[「（]$/.test(l))).toBe(false);
  });

  it('never cuts inside a Thai letter cluster', () => {
    const th =
      'วันนี้เราจะมาพูดคุยเกี่ยวกับเรื่องที่สำคัญมากที่สุดในชีวิตของทุกคนที่อยู่ที่นี่และที่นั่นด้วยกันทั้งหมดครับผม';
    for (let k = 0; k < 8; k++) {
      const text = 'ก'.repeat(k) + th;
      const lines = cueLines(srtOf(text)).flat();
      expect(lines.some((l) => /^\p{M}/u.test(l))).toBe(false);
      expect(lines.join('').replace(/Speaker 1: /g, '')).toBe(text);
    }
  });

  it('never cuts a surrogate pair', () => {
    const out = srtOf('あ𠮷い'.repeat(30));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(new TextDecoder().decode(new TextEncoder().encode(out))).not.toContain('\uFFFD');
  });

  it('ends cues at the sentence stops of other scripts', () => {
    const hi = [
      'यह इस उत्तर का पहला वाक्य है जो काफी लंबा है।',
      'और यह दूसरा वाक्य है जो भी काफी लंबा है।',
      'तीसरा वाक्य भी यहाँ है और यह भी लंबा है।',
    ].join(' ');
    const hiCues = cueTexts(srtOf(hi, 9000)).map((c) => c.replace(/\n/g, ' '));
    expect(hiCues.length).toBeGreaterThan(1);
    for (const c of hiCues) expect(c.endsWith('।')).toBe(true);
    const ur =
      'یہ پہلا جملہ ہے جو کافی لمبا ہے اور اس میں بہت سے الفاظ ہیں۔ یہ دوسرا جملہ ہے جو بھی لمبا ہے۔';
    for (const c of cueTexts(srtOf(ur, 9000))) expect(c.endsWith('۔')).toBe(true);
    const ja = '今日は「直」と「骨」の字を確認します。それから東京の話をしましょう。いいですね？';
    for (const c of cueTexts(srtOf(ja, 9000))) expect(c).toMatch(/[。？]$/);
  });

  it('starts every line of a right-to-left row with a right-to-left mark', () => {
    const ar = 'مرحبا، كيف حالك اليوم؟ لدي 3 أسئلة عن iPhone 15 وأريد أن أعرف المزيد عن الكاميرا والبطارية.';
    const lines = cueLines(srtOf(ar, 6000)).flat();
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(line.startsWith(RLM)).toBe(true);
      expect(firstStrong(line)).toBe('rtl');
    }
    // Text without letters goes by the row's language.
    expect(srtOf('١٢٣', 3000, 'ar').split('\r\n')[2]).toBe(`${RLM}Speaker 1: ١٢٣`);
    expect(srtOf('Hello there.', 3000, 'ar')).not.toContain(RLM);
  });
});

describe('TXT in other scripts', () => {
  it('starts every line of a right-to-left row with a right-to-left mark', () => {
    const txt = toTxt(buildExportRows(mixed, 'ar'));
    const [ar, ja] = txt.split('\n\n');
    expect(ar).toBe(`${RLM}Speaker 1: مرحبا، كيف حالك اليوم؟ لدي 3 أسئلة عن iPhone 15.`);
    expect(firstStrong(ar!)).toBe('rtl');
    expect(ja).toBe('المحاور: 今日は「直」と「骨」の字を確認します。');
    expect(toTxt(buildExportRows(doc1('שלום\nמה שלומך?')))).toBe(`${RLM}Speaker 1: שלום\n${RLM}מה שלומך?\n`);
  });
});

describe('DOCX in other scripts', () => {
  it('lays out Arabic right to left, with Arabic fonts and language', async () => {
    const { body, styles } = await docxXml(
      doc1('مرحبا، كيف حالك اليوم؟ لدي 3 أسئلة عن iPhone 15.', 3000),
      'ar',
    );
    const cell = cellOf(body, 'مرحبا');
    expect(cell).toContain('<w:bidi/>');
    // The Arabic is a right-to-left run; "iPhone 15." is not (LibreOffice would lay it out backwards).
    expect(cell).toMatch(
      /<w:rtl\/><w:lang w:bidi="ar-EG"\/><\/w:rPr><w:t xml:space="preserve">مرحبا[^<]*عن<\/w:t>/,
    );
    expect(cell).toMatch(
      /<w:rPr><w:lang w:bidi="ar-EG"\/><\/w:rPr><w:t xml:space="preserve"> iPhone 15\.<\/w:t>/,
    );
    expect(body).toContain('<w:bidiVisual/>');
    expect(styles).toContain('w:cs="Arial"');
    expect(styles).not.toContain('w:eastAsia="Calibri"');
    expect(styles).toContain('<w:lang w:bidi="ar-EG"/>');
  });

  it('tags each row with its own language, in the slot of its script', async () => {
    const { body, styles } = await docxXml(mixed, 'ja');
    expect(cellOf(body, '今日は')).toContain('<w:lang w:eastAsia="ja-JP"/>');
    expect(cellOf(body, '今天')).toContain('<w:lang w:eastAsia="zh-CN"/>');
    expect(cellOf(body, 'नमस्ते')).toContain('<w:lang w:bidi="hi-IN"/>');
    expect(cellOf(body, 'नमस्ते')).not.toContain('<w:bidi/>');
    expect(cellOf(body, 'Bonjour')).toContain('<w:lang w:val="fr-FR"/>');
    expect(cellOf(body, 'مرحبا')).toContain('<w:lang w:bidi="ar-EG"/>');
    expect(cellOf(body, 'مرحبا')).toContain('<w:bidi/>');
    // A row without its own language is in the transcript's.
    expect(cellOf(body, 'Hello.')).toContain('<w:lang w:eastAsia="ja-JP"/>');
    // The speaker name is right to left too, but not tagged with a language.
    expect(cellOf(body, '>المحاور<')).toMatch(
      /<w:bidi\/>.*<w:rtl\/><\/w:rPr><w:t xml:space="preserve">المحاور/,
    );
    expect(body).not.toContain('bidiVisual');
    expect(body).toContain('Languages: Japanese (ja), Arabic (ar), Chinese (zh), Hindi (hi), French (fr)');
    expect(styles).toContain('<w:lang w:eastAsia="ja-JP"/>');
  });

  it('leaves English as it was', async () => {
    const { body, styles } = await docxXml(doc1('Hello there.', 3000), 'en');
    expect(body).not.toMatch(/<w:bidi|<w:rtl|bidiVisual/);
    expect(cellOf(body, 'Hello there.')).toContain('<w:lang w:val="en-US"/>');
    expect(body).toContain('Language: English (en)');
    expect(styles).toContain('w:ascii="Calibri"');
  });
});

describe('XLSX in other scripts', () => {
  async function sheets(document: TranscriptDocument, languageCode: string | null) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await renderExport('xlsx', input(document, languageCode))).bytes as unknown as ArrayBuffer,
    );
    return { ws: wb.getWorksheet('Transcript')!, info: wb.getWorksheet('Info')! };
  }

  it('runs the sheet right to left for a right-to-left transcript', async () => {
    const { ws, info } = await sheets(mixed, 'ar');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, rightToLeft: true });
    expect(ws.getCell('E2').alignment?.readingOrder).toBe('rtl');
    expect(ws.getCell('E3').alignment?.readingOrder).not.toBe('rtl');
    expect(ws.getCell('B3').alignment?.readingOrder).toBe('rtl');
    expect(info.getCell('A5').value).toBe('Languages');
    expect(info.getCell('B5').value).toBe(
      'Arabic (ar), Japanese (ja), Chinese (zh), Hindi (hi), French (fr)',
    );
  });

  it('keeps a left-to-right sheet otherwise', async () => {
    const { ws, info } = await sheets(mixed, 'en');
    expect(ws.views[0]?.rightToLeft).toBeFalsy();
    expect(ws.getCell('E2').alignment?.readingOrder).toBe('rtl');
    expect(info.getCell('A5').value).toBe('Languages');
    const english = await sheets(doc1('Hello.'), 'en');
    expect(english.ws.views[0]?.rightToLeft).toBeFalsy();
    expect(english.info.getCell('B5').value).toBe('English (en)');
  });
});
