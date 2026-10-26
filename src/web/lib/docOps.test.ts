import type { TranscriptRow } from '../../shared/types';
import { mergeWithNext, mergeWithPrevious, type EditableDoc } from './docOps';

const docOf = (...rows: Partial<TranscriptRow>[]): EditableDoc => ({
  speakers: [{ id: 'a', name: 'A', colorIndex: 0 }],
  rows: rows.map((r, i) => ({ id: String(i + 1), speakerId: 'a', startMs: i, endMs: i + 1, text: '', ...r })),
});

describe('merging rows', () => {
  it('joins the text as the language is written', () => {
    expect(
      mergeWithNext(docOf({ text: 'Hello there. ' }, { text: ' How are you?' }), '1').rows[0]!.text,
    ).toBe('Hello there. How are you?');
    expect(
      mergeWithNext(docOf({ text: 'そうですね。' }, { text: '分かりました。' }), '1').rows[0]!.text,
    ).toBe('そうですね。分かりました。');
    expect(
      mergeWithPrevious(docOf({ text: '我们今天讨论' }, { text: '这个问题。' }), '2').rows[0]!.text,
    ).toBe('我们今天讨论这个问题。');
  });

  it('keeps the upper row’s language, or the lower one’s when the upper row was empty', () => {
    const merged = mergeWithNext(
      docOf({ text: 'Bonjour.', lang: 'fr' }, { text: 'Hello.', lang: 'en' }),
      '1',
    );
    expect(merged.rows).toEqual([
      { id: '1', speakerId: 'a', startMs: 0, endMs: 2, text: 'Bonjour. Hello.', lang: 'fr' },
    ]);
    expect(mergeWithNext(docOf({ text: ' ' }, { text: 'Hola.', lang: 'es' }), '1').rows[0]!.lang).toBe('es');
    expect(mergeWithNext(docOf({ text: ' ', lang: 'fr' }, { text: 'Hi.' }), '1').rows[0]).not.toHaveProperty(
      'lang',
    );
  });
});
