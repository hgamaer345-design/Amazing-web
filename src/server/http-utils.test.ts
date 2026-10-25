import { AppError } from './errors';
import { attachmentDisposition, downloadFileName, toAppError, truncateText } from './http-utils';

function decodeFilenameStar(header: string): string {
  const match = /filename\*=UTF-8''([^;]+)/.exec(header);
  if (!match) throw new Error(`No filename* in ${header}`);
  return decodeURIComponent(match[1]!);
}

function asciiFilename(header: string): string {
  const match = /filename="([^"]*)"/.exec(header);
  if (!match) throw new Error(`No filename in ${header}`);
  return match[1]!;
}

describe('downloadFileName', () => {
  it('keeps ordinary titles and appends the extension', () => {
    expect(downloadFileName('Team meeting 2026-03-01', 'csv')).toBe('Team meeting 2026-03-01.csv');
    expect(downloadFileName('Café über 日本', 'docx')).toBe('Café über 日本.docx');
  });

  it('replaces characters that are invalid in file names', () => {
    expect(downloadFileName('Interview: A/B "final"?', 'txt')).toBe('Interview_ A_B _final__.txt');
    expect(downloadFileName('tab\there\nnewline', 'srt')).toBe('tab here newline.srt');
    expect(downloadFileName('..hidden.. ', 'csv')).toBe('hidden.csv');
  });

  it('falls back to "transcript" and limits the length', () => {
    expect(downloadFileName('   ', 'xlsx')).toBe('transcript.xlsx');
    expect(downloadFileName('...', 'xlsx')).toBe('transcript.xlsx');
    const long = downloadFileName('x'.repeat(500), 'csv');
    expect(long).toBe(`${'x'.repeat(150)}.csv`);
  });
});

describe('attachmentDisposition', () => {
  it('sends an ASCII fallback and the exact UTF-8 name (RFC 5987)', () => {
    const header = attachmentDisposition('Café über 日本.csv');
    expect(header.startsWith('attachment; ')).toBe(true);
    expect(asciiFilename(header)).toBe('Cafe uber _.csv');
    expect(decodeFilenameStar(header)).toBe('Café über 日本.csv');
    expect(header).toMatch(/filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
  });

  it('escapes characters that RFC 5987 does not allow literally', () => {
    const header = attachmentDisposition("it's (draft) * 100%.txt");
    expect(header).toContain("filename*=UTF-8''it%27s%20%28draft%29%20%2A%20100%25.txt");
    expect(asciiFilename(header)).toBe("it's (draft) * 100_.txt");
  });

  it('uses a generic ASCII name when nothing readable is left', () => {
    const header = attachmentDisposition('日本語.docx');
    expect(asciiFilename(header)).toBe('transcript.docx');
    expect(decodeFilenameStar(header)).toBe('日本語.docx');
  });

  it('never puts quotes or backslashes inside the quoted name', () => {
    expect(asciiFilename(attachmentDisposition('a\\b.csv'))).toBe('a_b.csv');
  });
});

describe('truncateText', () => {
  it('does not split surrogate pairs', () => {
    expect(truncateText('ab😀cd', 3)).toBe('ab');
    expect(truncateText('ab😀cd', 4)).toBe('ab😀');
    expect(truncateText('short', 10)).toBe('short');
  });
});

describe('toAppError', () => {
  it('passes AppErrors through', () => {
    const err = new AppError('NOT_READY');
    expect(toAppError(err)).toBe(err);
  });

  it('maps body-parser errors', () => {
    expect(
      toAppError(Object.assign(new SyntaxError('x'), { status: 400, type: 'entity.parse.failed' })),
    ).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect(
      toAppError(Object.assign(new Error('x'), { status: 413, type: 'entity.too.large' })),
    ).toMatchObject({
      code: 'INVALID_INPUT',
      status: 413,
    });
    expect(
      toAppError(Object.assign(new Error('x'), { status: 415, type: 'charset.unsupported' })),
    ).toMatchObject({
      code: 'INVALID_INPUT',
      status: 415,
    });
  });

  it('keeps other client error statuses', () => {
    expect(toAppError(Object.assign(new Error('x'), { status: 416 }))).toMatchObject({
      code: 'INVALID_INPUT',
      status: 416,
    });
    expect(toAppError(Object.assign(new Error('x'), { statusCode: 404 }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('turns everything else into a generic 500 without internals', () => {
    for (const err of [new Error('SQLITE_CORRUPT at /var/data/db'), 'boom', null, { status: 503 }]) {
      const mapped = toAppError(err);
      expect(mapped.code).toBe('INTERNAL');
      expect(mapped.status).toBe(500);
      expect(JSON.stringify(mapped.toBody())).not.toMatch(/SQLITE|var|boom/);
    }
  });
});
