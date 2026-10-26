import {
  cleanTranscript,
  type ClipDecode,
  collapseRepeats,
  hasLoop,
  isHallucinationPhrase,
  isLooping,
  stripHallucinationPhrases,
  transcribeChecked,
} from './text';

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

/** A decode whose tokens are the given pieces ("text:logprob"), e.g. ' Thank:-0.9'. */
function decodeOf(pieces: string[], opts: { end?: number | null; noSpeech?: number } = {}): ClipDecode {
  const vocab = new Map<string, number>();
  const tokens = pieces.map((p) => {
    const at = p.lastIndexOf(':');
    const text = p.slice(0, at);
    if (!vocab.has(text)) vocab.set(text, vocab.size);
    return { id: vocab.get(text)!, text, logprob: Number(p.slice(at + 1)) };
  });
  const byId = new Map([...vocab].map(([text, id]) => [id, text]));
  return {
    text: tokens.map((t) => t.text).join(''),
    tokens,
    endLogprob: opts.end === undefined ? -0.1 : opts.end,
    noSpeechProb: opts.noSpeech ?? 0.05,
    detokenize: (ids) => ids.map((id) => byId.get(id)).join(''),
  };
}

const sure = (text: string) => text.split(/(?= )/).map((w) => `${w}:-0.1`);

describe('hasLoop', () => {
  it('finds a token pattern repeating back to back', () => {
    const again = [1, 2, 3, 4]; // " and we went back"
    expect(hasLoop([9, 8, ...again, ...again, ...again, ...again, ...again])).toBe(true);
    expect(hasLoop(Array.from({ length: 40 }, (_, i) => i % 9))).toBe(true);
  });

  it('leaves ordinary repetition alone', () => {
    expect(hasLoop([5, 5, 5, 6, 7])).toBe(false); // "no, no, no"
    expect(hasLoop([1, 2, 1, 2, 3, 4])).toBe(false); // "I had I had had"
    expect(hasLoop(Array.from({ length: 60 }, (_, i) => i))).toBe(false);
  });
});

describe('isLooping', () => {
  it('also counts a sentence said three times, not back to back', () => {
    const said = sure(' It was a good day.');
    const other = sure(' It was fine.');
    expect(isLooping(decodeOf([...said, ...other, ...said, ...said]))).toBe(true);
    expect(isLooping(decodeOf([...said, ...other, ...said]))).toBe(false);
    expect(isLooping(decodeOf([...sure(' Okay.'), ...sure(' Okay.'), ...sure(' Okay.')]))).toBe(false); // too short
  });
});

describe('isHallucinationPhrase', () => {
  it('knows the subtitle credits and video outros', () => {
    expect(isHallucinationPhrase('Thank you for watching.')).toBe(true);
    expect(isHallucinationPhrase(' So thank you for watching.')).toBe(true);
    expect(isHallucinationPhrase('Thanks for watching!')).toBe(true);
    expect(isHallucinationPhrase('Subtitles by the Amara.org community')).toBe(true);
    expect(isHallucinationPhrase('ご視聴ありがとうございました')).toBe(true);
  });

  it('does not match other sentences', () => {
    expect(isHallucinationPhrase('Thank you for coming in today.')).toBe(false);
    expect(isHallucinationPhrase('I was watching it.')).toBe(false);
    expect(isHallucinationPhrase('')).toBe(false);
  });
});

describe('stripHallucinationPhrases', () => {
  it('drops a doubtful phrase at the end but keeps a confident one', () => {
    const tail = [' Thank:-0.9', ' you:-0.8', ' for:-0.9', ' watching:-1.7', '.:-0.9'];
    expect(stripHallucinationPhrases(decodeOf([...sure(' We are done.'), ...tail]))).toBe(' We are done.');
    const said = decodeOf([...sure(' That was the news.'), ' Thank:-0.1', ' you:-0.02', '.:-0.1']);
    expect(stripHallucinationPhrases(said)).toBe(' That was the news. Thank you.');
  });

  it('keeps a phrase that more speech follows', () => {
    const lead = decodeOf([' Thank:-0.6', ' you:-0.3', '.:-0.2', ...sure(' I love the design.')]);
    expect(stripHallucinationPhrases(lead)).toBe(' Thank you. I love the design.');
  });
});

describe('transcribeChecked', () => {
  const run = async (first: ClipDecode, second?: ClipDecode) => {
    const calls: boolean[] = [];
    const verdict = await transcribeChecked(async (timestamps) => {
      calls.push(timestamps);
      return timestamps ? second! : first;
    }, 3);
    return { ...verdict, calls };
  };

  it('keeps a confident decode without a second pass', async () => {
    const v = await run(decodeOf(sure(' We tested it on Monday.')));
    expect(v).toMatchObject({ text: 'We tested it on Monday.', retried: false, calls: [false] });
    expect(v.dropped).toBeUndefined();
  });

  it('drops silence: Whisper says no speech and is unsure', async () => {
    const v = await run(decodeOf([' Okay:-2.4', '.:-0.8'], { noSpeech: 0.7 }));
    expect(v).toMatchObject({ text: '', dropped: 'silence', calls: [false] });
  });

  it('keeps an unsure but voiced short answer', async () => {
    const v = await run(decodeOf([' Um:-0.7', '...:-0.9'], { noSpeech: 0.77 }));
    expect(v.text).toBe('Um...');
  });

  it('retries a loop with timestamps and keeps the retry', async () => {
    const loop = decodeOf(
      [' We:-1', ' left:-1', ...Array(6).fill([' and:-0.1', ' we:-0.1', ' went:-0.1', ' back:-0.1']).flat()],
      {
        end: null,
      },
    );
    const v = await run(loop, decodeOf(sure(' Where did you grow up?')));
    expect(v).toMatchObject({ text: 'Where did you grow up?', retried: true, calls: [false, true] });
  });

  it('keeps the text before a loop that survives the retry, if it is likely', async () => {
    const loop = decodeOf(Array(8).fill([' I:-0.1', ' mean:-0.1', ' that.:-0.1']).flat());
    expect(await run(loop, loop)).toMatchObject({ text: 'I mean that.', retried: true });
    const start = [' So:-2.5', ' then:-2.4', ' she:-2.6', ' said:-2.5', ' it:-2.4', ' was:-2.6'];
    const unsure = decodeOf(
      [...start, ...Array(8).fill([' back:-0.1', ' and:-0.1', ' we:-0.1', ' went:-0.1'])].flat(),
    );
    expect((await run(unsure, unsure)).dropped).toBe('loop');
  });

  it('drops a clip that stays unlikely after the retry', async () => {
    const unlikely = decodeOf([' I:-1.8', ' think:-1.3', ' so:-2.0', '.:-1.2'], { end: -1.4 });
    expect(await run(unlikely, unlikely)).toMatchObject({ text: '', dropped: 'low-confidence' });
  });

  it('removes a doubtful "Thank you for watching."', async () => {
    const v = await run(
      decodeOf([' So:-0.7', ' thank:-1', ' you:-0.01', ' for:-1', ' watching:-1.8', '.:-0.9'], {
        noSpeech: 0.4,
      }),
    );
    expect(v).toMatchObject({ text: '', dropped: 'phrase' });
  });
});

describe('isHallucinationPhrase across languages', () => {
  it('matches the credits however they are punctuated', () => {
    expect(isHallucinationPhrase('Sous-titres réalisés para la communauté d’Amara.org')).toBe(true);
    expect(isHallucinationPhrase('Untertitel der Amara.org-Community')).toBe(true);
    expect(isHallucinationPhrase("Don't forget to subscribe!")).toBe(true);
    expect(isHallucinationPhrase('Okay, thank you.')).toBe(true);
    expect(isHallucinationPhrase('Thank you, Anna.')).toBe(false);
    expect(isHallucinationPhrase('Редактор субтитров А.Синецкая Корректор А.Сухиашвили')).toBe(true);
    expect(isHallucinationPhrase('Subtitles by Steamteamextra')).toBe(true);
    expect(isHallucinationPhrase('Subtitles are on.')).toBe(false);
  });
});
