import { cleanTranscript, collapseRepeats } from './text';

describe('cleanTranscript', () => {
  it('drops sound tags and keeps real words', () => {
    expect(cleanTranscript('[Music]', 3)).toBe('');
    expect(cleanTranscript(' ♪ ♪ ', 3)).toBe('');
    expect(cleanTranscript('(laughs) That was great. [BLANK_AUDIO]', 3)).toBe('That was great.');
  });

  it('drops a lone "you" only on very short clips', () => {
    expect(cleanTranscript(' you', 0.8)).toBe('');
    expect(cleanTranscript('You.', 1.5)).toBe('');
    expect(cleanTranscript('You.', 4)).toBe('You.');
    expect(cleanTranscript('Thank you.', 1)).toBe('Thank you.');
  });
});

describe('collapseRepeats', () => {
  it('collapses a phrase repeated four or more times in a row', () => {
    expect(collapseRepeats('I mean, I mean, I mean, I mean, I mean, we tried.')).toBe('I mean, we tried.');
    expect(collapseRepeats('and then and then and then and then and then')).toBe('and then');
    expect(collapseRepeats('Ah, ah, ah, ah, ah, ah, ah, ah, ah, ah, ah, ah')).toBe('Ah,');
  });

  it('leaves ordinary repetition alone', () => {
    const text = 'No, no, no. We tried it again and again and again.';
    expect(collapseRepeats(text)).toBe(text);
    expect(collapseRepeats('very very very very good')).toBe('very very very very good');
  });
});
