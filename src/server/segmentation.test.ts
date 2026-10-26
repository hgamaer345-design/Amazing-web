import { buildDocument } from './segmentation';

const seg = (speaker: string, startMs: number, text: string, lang?: string) => ({
  speaker,
  startMs,
  endMs: startMs + 1000,
  text,
  ...(lang ? { lang } : {}),
});

describe('buildDocument', () => {
  it('joins a speaker’s segments as the language is written', () => {
    const { rows } = buildDocument([
      seg('S0', 0, '我们今天讨论这个问题'),
      seg('S0', 1000, '然后再决定。'),
      seg('S1', 2000, 'Hello there.'),
      seg('S1', 3000, 'How are you?'),
      seg('S2', 4000, 'สวัสดีครับ'),
      seg('S2', 5000, 'ยินดีที่ได้รู้จัก'),
    ]);
    expect(rows.map((r) => r.text)).toEqual([
      '我们今天讨论这个问题然后再决定。',
      'Hello there. How are you?',
      'สวัสดีครับ ยินดีที่ได้รู้จัก',
    ]);
  });

  it('joins word-level results (Ultra High) without spaces in Japanese', () => {
    const words = ['今日', 'は', 'いい', '天気', 'です', 'ね。'].map((w, i) => seg('0', i * 300, w));
    expect(buildDocument(words).rows.map((r) => r.text)).toEqual(['今日はいい天気ですね。']);
  });

  it('keeps each segment’s language on its row and starts a row when it changes', () => {
    const { speakers, rows } = buildDocument([
      seg('S0', 0, 'Bonjour.', 'fr'),
      seg('S0', 1000, 'Ça va ?', 'fr'),
      seg('S0', 2000, 'Hello.', 'en'),
      seg('S1', 3000, 'مرحبا', 'ar'),
      seg('S1', 4000, 'No language given.'),
    ]);
    expect(speakers).toHaveLength(2);
    expect(rows.map((r) => [r.text, r.lang])).toEqual([
      ['Bonjour. Ça va ?', 'fr'],
      ['Hello.', 'en'],
      ['مرحبا', 'ar'],
      ['No language given.', undefined],
    ]);
    expect(rows[3]).not.toHaveProperty('lang');
  });
});
