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
import { speakerColor } from '../../shared/speakers';
import { formatDuration } from '../../shared/time';
import type { ExportInput } from './index';
import { formatCreated, languageLabel, speakersInOrder, type ExportRow } from './common';

// A4 with 1" margins leaves 9026 twips of text width.
const COLUMN_WIDTHS = [600, 1800, 1100, 1100, 4426];
const HEADER_FILL = 'F1F3F6';
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'C4CAD3' };

function hex(color: string): string {
  return color.replace('#', '').toUpperCase();
}

/** Paragraphs for a cell, keeping line breaks inside the text. */
function textParagraphs(text: string, run: { bold?: boolean; color?: string } = {}): Paragraph[] {
  const lines = text.split('\n');
  return [
    new Paragraph({
      children: lines.map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined, ...run })),
    }),
  ];
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

export async function toDocx(rows: ExportRow[], input: ExportInput): Promise<Buffer> {
  const speakers = speakersInOrder(rows);
  const meta = [
    `File: ${input.originalFilename}`,
    `Created: ${formatCreated(input.createdAt)}`,
    `Duration: ${formatDuration(input.durationSec)}`,
    `Language: ${languageLabel(input.languageCode)}`,
  ].join('   ·   ');

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: ['#', 'Speaker', 'Start', 'End', 'Text'].map((label, i) =>
      cell([new Paragraph({ children: [new TextRun({ text: label, bold: true })] })], COLUMN_WIDTHS[i]!, true),
    ),
  });

  const bodyRows = rows.map(
    (r) =>
      new TableRow({
        children: [
          cell(textParagraphs(String(r.number)), COLUMN_WIDTHS[0]!),
          cell(
            textParagraphs(r.speakerName, {
              bold: true,
              ...(r.colorIndex != null ? { color: hex(speakerColor(r.colorIndex).base) } : {}),
            }),
            COLUMN_WIDTHS[1]!,
          ),
          cell(textParagraphs(r.start), COLUMN_WIDTHS[2]!),
          cell(textParagraphs(r.end), COLUMN_WIDTHS[3]!),
          cell(textParagraphs(r.text), COLUMN_WIDTHS[4]!),
        ],
      }),
  );

  const speakerRuns: TextRun[] = [new TextRun({ text: 'Speakers: ', bold: true })];
  speakers.forEach((s, i) => {
    if (i > 0) speakerRuns.push(new TextRun({ text: ', ' }));
    speakerRuns.push(
      new TextRun({
        text: s.name,
        bold: true,
        ...(s.colorIndex != null ? { color: hex(speakerColor(s.colorIndex).base) } : {}),
      }),
    );
  });
  if (!speakers.length) speakerRuns.push(new TextRun({ text: '—' }));

  const doc = new Document({
    creator: 'Speaker Transcriber',
    title: input.title,
    description: `Transcript of ${input.originalFilename}`,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 21 } } },
    },
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: input.title })] }),
          new Paragraph({ children: [new TextRun({ text: meta, color: '5B6474', size: 18 })] }),
          new Paragraph({ spacing: { after: 200 }, children: speakerRuns }),
          new Table({
            width: { size: COLUMN_WIDTHS.reduce((a, b) => a + b, 0), type: WidthType.DXA },
            columnWidths: COLUMN_WIDTHS,
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
  return Packer.toBuffer(doc);
}
