import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { speakerColor } from '../speakers';
import { formatDuration } from '../time';
import type { ExportInput } from './render';
import {
  formatCreated,
  isRtlText,
  isRtlTranscript,
  languagesField,
  RTL_LETTER,
  speakersInOrder,
  type ExportRow,
} from './common';

// A4 with 1" margins leaves 9026 twips of text width.
const COLUMN_WIDTHS = [600, 1800, 1100, 1100, 4426];
const HEADER_FILL = 'F1F3F6';
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'C4CAD3' };

/**
 * Word's font for Arabic and Hebrew (the complex-script slot), as in its own theme: Calibri has
 * neither, and Word would show them in whatever font it substitutes.
 */
const COMPLEX_SCRIPT_FONT = 'Arial';

function hex(color: string): string {
  return color.replace('#', '').toUpperCase();
}

/** A run's languages: Word keeps one for Latin-like text, one for East Asian, one for complex scripts. */
type RunLanguage = { value?: string } | { eastAsia: string } | { bidirectional: string };

/** Scripts Word treats as complex (shaped, often right to left), whose language goes in w:bidi. */
// prettier-ignore
const COMPLEX_SCRIPTS = new Set([
  'Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm', 'Deva', 'Beng', 'Guru', 'Gujr', 'Orya', 'Taml',
  'Telu', 'Knda', 'Mlym', 'Sinh', 'Thai', 'Laoo', 'Khmr', 'Mymr', 'Tibt',
]);

const runLanguages = new Map<string, RunLanguage | null>();

/**
 * The w:lang for text in a language ("ar" -> bidi "ar-EG", "ja" -> eastAsia "ja-JP", "fr" -> "fr-FR"),
 * for spelling, fonts and, for Chinese and Japanese, which form of a shared character to draw (直 and
 * 骨 differ). Only the slot of the language's own script is set, from the row's own language: Arabic
 * text tagged Japanese is drawn by LibreOffice in a fallback font, unshaped.
 */
function runLanguage(code: string | null): RunLanguage | null {
  if (!code) return null;
  let lang = runLanguages.get(code);
  if (lang === undefined) {
    lang = null;
    try {
      // Whisper's "jw" is Javanese ("jv"); Word knows Cantonese as Hong Kong Chinese.
      const tag = code
        .replace(/_/g, '-')
        .replace(/^jw(?=-|$)/i, 'jv')
        .replace(/^yue(?=-|$)/i, 'zh-HK');
      const locale = new Intl.Locale(tag).maximize();
      const name = locale.region ? `${locale.language}-${locale.region}` : locale.language;
      if (['zh', 'ja', 'ko'].includes(locale.language)) lang = { eastAsia: name };
      else if (locale.script && COMPLEX_SCRIPTS.has(locale.script)) lang = { bidirectional: name };
      else lang = { value: name };
    } catch {
      // Not a language tag Intl knows: leave the text untagged.
    }
    runLanguages.set(code, lang);
  }
  return lang;
}

/** Arabic, Hebrew, … text from its first right-to-left letter to its last before a Latin letter. */
const RTL_RUN = new RegExp(
  `${RTL_LETTER.source}(?:(?:\\P{L}|${RTL_LETTER.source})*${RTL_LETTER.source})?`,
  'gu',
);

/**
 * The line cut into right-to-left runs (w:rtl, as Word writes Arabic and Hebrew) and the others.
 * Latin words and numbers between them stay outside: an "iPhone 15" marked right to left is laid
 * out backwards by LibreOffice ("iPhon" / "e 15").
 */
function directionalRuns(line: string): { text: string; rtl: boolean }[] {
  const out: { text: string; rtl: boolean }[] = [];
  let at = 0;
  for (const m of line.matchAll(RTL_RUN)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index), rtl: false });
    out.push({ text: m[0], rtl: true });
    at = m.index + m[0].length;
  }
  if (at < line.length || !out.length) out.push({ text: line.slice(at), rtl: false });
  return out;
}

type RunStyle = { bold?: boolean; color?: string; size?: number };

/**
 * Runs for text in `lang` (null: not tagged), keeping line breaks inside the text, with
 * right-to-left runs for Arabic, Hebrew, … text.
 */
function textRuns(text: string, lang: string | null, style: RunStyle = {}): TextRun[] {
  const language = runLanguage(lang);
  return text.split('\n').flatMap((line, i) =>
    directionalRuns(line).map(
      (part, j) =>
        new TextRun({
          text: part.text,
          break: i > 0 && j === 0 ? 1 : undefined,
          ...(part.rtl ? { rightToLeft: true } : {}),
          ...(language ? { language } : {}),
          ...style,
        }),
    ),
  );
}

/** A paragraph of text in `lang`; a right-to-left paragraph when the text reads that way. */
function textParagraph(
  text: string,
  lang: string | null,
  style: RunStyle = {},
  heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel],
): Paragraph {
  return new Paragraph({
    ...(heading ? { heading } : {}),
    ...(isRtlText(text, lang) ? { bidirectional: true } : {}),
    children: textRuns(text, lang, style),
  });
}

function cell(children: Paragraph[], width: number, shaded = false): TableCell {
  return new TableCell({
    children,
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    ...(shaded ? { shading: { type: ShadingType.CLEAR, fill: HEADER_FILL, color: 'auto' } } : {}),
  });
}

/**
 * Word document: title, details and a table of the rows. Each row's text is tagged with its
 * language (the row's own in a multi-language transcript) and laid out right to left when it is
 * Arabic, Hebrew, …; the table runs right to left when the transcript does.
 */
export async function toDocx(rows: ExportRow[], input: ExportInput): Promise<Uint8Array> {
  const speakers = speakersInOrder(rows);
  const [languageName, languages] = languagesField(rows, input.languageCode);
  const meta = [
    `File: ${input.originalFilename}`,
    `Created: ${formatCreated(input.createdAt)}`,
    `Duration: ${formatDuration(input.durationSec)}`,
    `${languageName}: ${languages}`,
  ].join('   ·   ');

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: ['#', 'Speaker', 'Start', 'End', 'Text'].map((label, i) =>
      cell(
        [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
        COLUMN_WIDTHS[i]!,
        true,
      ),
    ),
  });

  const speakerStyle = (colorIndex: number | null): RunStyle => ({
    bold: true,
    ...(colorIndex != null ? { color: hex(speakerColor(colorIndex).base) } : {}),
  });

  const bodyRows = rows.map(
    (r) =>
      new TableRow({
        children: [
          cell([textParagraph(String(r.number), null)], COLUMN_WIDTHS[0]!),
          cell([textParagraph(r.speakerName, null, speakerStyle(r.colorIndex))], COLUMN_WIDTHS[1]!),
          cell([textParagraph(r.start, null)], COLUMN_WIDTHS[2]!),
          cell([textParagraph(r.end, null)], COLUMN_WIDTHS[3]!),
          cell([textParagraph(r.text, r.lang)], COLUMN_WIDTHS[4]!),
        ],
      }),
  );

  const speakerRuns: TextRun[] = [new TextRun({ text: 'Speakers: ', bold: true })];
  speakers.forEach((s, i) => {
    if (i > 0) speakerRuns.push(new TextRun({ text: ', ' }));
    speakerRuns.push(...textRuns(s.name, null, speakerStyle(s.colorIndex)));
  });
  if (!speakers.length) speakerRuns.push(new TextRun({ text: '—' }));

  const defaultLanguage = runLanguage(input.languageCode);
  const doc = new Document({
    creator: 'Speaker Transcriber',
    title: input.title,
    description: `Transcript of ${input.originalFilename}`,
    styles: {
      default: {
        document: {
          run: {
            // No East Asian font: Word and LibreOffice then pick one for the text's language.
            font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: COMPLEX_SCRIPT_FONT },
            size: 21,
            ...(defaultLanguage ? { language: defaultLanguage } : {}),
          },
        },
      },
    },
    sections: [
      {
        children: [
          textParagraph(input.title, null, {}, HeadingLevel.HEADING_1),
          new Paragraph({ children: [new TextRun({ text: meta, color: '5B6474', size: 18 })] }),
          new Paragraph({ spacing: { after: 200 }, children: speakerRuns }),
          new Table({
            width: { size: COLUMN_WIDTHS.reduce((a, b) => a + b, 0), type: WidthType.DXA },
            columnWidths: COLUMN_WIDTHS,
            ...(isRtlTranscript(rows, input.languageCode) ? { visuallyRightToLeft: true } : {}),
            borders: {
              top: BORDER,
              bottom: BORDER,
              left: BORDER,
              right: BORDER,
              insideHorizontal: BORDER,
              insideVertical: BORDER,
            },
            rows: [headerRow, ...bodyRows],
          }),
        ],
      },
    ],
  });
  return Packer.pack(doc, 'uint8array');
}
