import {
  cleanTranscript,
  type ClipDecode,
  collapseRepeats,
  deloop,
  hasLoop,
  isHallucinationPhrase,
  isLooping,
  loopGuard,
  maxClipTokens,
  repeatStart,
  sentences,
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

/**
 * A decode whose tokens are the given pieces ("text:logprob"), e.g. ' Thank:-0.9'. Pieces share
 * ids by their text (so decodes made from the same `vocab` do too).
 */
function decodeOf(
  pieces: string[],
  opts: { end?: number | null; truncated?: boolean; noSpeech?: number; vocab?: Map<string, number> } = {},
): ClipDecode {
  const vocab = opts.vocab ?? new Map<string, number>();
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
    endLogprob: opts.truncated ? null : opts.end === undefined ? -0.1 : opts.end,
    truncated: opts.truncated ?? false,
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

  it('needs the copies after the first to cover 16 tokens', () => {
    const copies = (run: number[], n: number) => Array<number[]>(n).fill(run).flat();
    expect(hasLoop(copies([1, 2, 3, 4], 4))).toBe(false); // 12 tokens after the first copy
    expect(hasLoop(copies([1, 2, 3, 4], 5))).toBe(true);
    expect(hasLoop(copies([1, 2, 3, 4, 5, 6], 3))).toBe(false);
    expect(hasLoop(copies([1, 2, 3, 4, 5, 6, 7, 8], 3))).toBe(true);
  });
});

describe('loopGuard', () => {
  const scored = (ids: number[], logprob = -0.1) => ids.map((id) => ({ id, logprob }));
  /** Feeds the guard `ids` one step at a time; returns each step's action by the text so far. */
  const steps = (guard: ReturnType<typeof loopGuard>, ids: number[], logprob?: number) =>
    ids.map((_, i) => guard(scored(ids.slice(0, i + 1), logprob)));
  const chant = Array<number[]>(9).fill([7, 8]).flat(); // " Go!" nine times: 16 tokens after the first

  it('first bans only the token that would continue the loop, so Whisper can move on', () => {
    const guard = loopGuard(440);
    const actions = steps(guard, [...chant, 20, 21, 22, 23]);
    expect(actions.slice(0, 17).every((a) => a === null)).toBe(true);
    expect(actions[17]).toEqual({ ban: [7] });
    expect(actions.slice(18)).toEqual([null, null, null, null]);
  });

  it('ends the text if Whisper keeps looping after the ban', () => {
    const guard = loopGuard(440);
    const actions = steps(guard, [...chant, ...Array<number[]>(9).fill([9, 8]).flat()]);
    expect(actions[17]).toEqual({ ban: [7] });
    expect(actions.slice(18, 34).every((a) => a === null)).toBe(true);
    expect(actions[34]).toBe('end'); // the copies after " Go?" cover 16 tokens again
  });

  it('keeps the ban until Whisper writes text (timestamps come in between)', () => {
    const guard = loopGuard(440);
    steps(guard, chant);
    expect(guard(scored(chant))).toEqual({ ban: [7] }); // the step after a timestamp: same text
    expect(guard(scored([...chant, 30]))).toBeNull();
  });

  it('ends at once when the loop already fills half the token limit', () => {
    expect(steps(loopGuard(36), chant).at(-1)).toBe('end');
  });

  it('ends at once when Whisper was unsure of the text so far (a loop on noise)', () => {
    expect(steps(loopGuard(440), chant, -0.7).at(-1)).toBe('end');
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

  it('not when Whisper went on to new speech after the third time, unless the text was cut off', () => {
    const thanks = sure(' Thank you so much.');
    const speech = [...thanks, ...thanks, ...thanks, ...sure(" It's an honour to be here tonight.")];
    expect(isLooping(decodeOf(speech))).toBe(false);
    expect(isLooping(decodeOf(speech, { end: null }))).toBe(true);
    const there = sure(' Can you hear me?');
    const phone = [
      ...sure(' Hello?'),
      ...there,
      ...sure(' Hello?'),
      ...there,
      ...there,
      ...sure(' Okay, I hear you.'),
    ];
    expect(repeatStart(decodeOf(phone).tokens)).toBe(-1);
    expect(repeatStart(decodeOf(phone).tokens, undefined, true)).toBe(6);
  });
});

describe('deloop', () => {
  it('keeps one copy of a run said back to back, and the text after it', () => {
    const no = [' No:-0.2', ',:-0.1', ...Array(10).fill([' no:-0.1', ',:-0.1']).flat()];
    const d = decodeOf([...no, ' no:-0.1', '!:-0.1', ...sure(' I am not going back there.')]);
    const out = deloop(d);
    expect(out.text).toBe(' No, no! I am not going back there.');
    expect(out.endLogprob).toBe(-0.1);
    expect(isLooping(out)).toBe(false);
  });

  it('takes out whole copies only, so no character is cut in two', () => {
    // " Go!" nine times, then " Go" and " Come": the last " Go" is not a whole copy.
    const go = decodeOf([
      ...Array(10).fill([' Go:-0.1', '!:-0.1']).flat().slice(0, -1),
      ' Come:-0.1',
      '.:-0.1',
    ]);
    expect(deloop(go).text).toBe(' Go! Go Come.');
  });

  it('cuts at the loop when what Whisper wrote after it is unlikely or no speech', () => {
    const loop = Array(9).fill([" I'm:-0.7", ' just:-0.8', ' like,:-0.8']).flat();
    const start = sure(' I am going to be an eagle.');
    const invented = decodeOf([...start, ...loop, " can't:-1.9", ' believe:-1.7', ' it.:-0.4']);
    expect(deloop(invented).text).toBe(" I am going to be an eagle. I'm just like,");
    expect(deloop(invented).endLogprob).toBeNull();
    const dot = decodeOf([' Oh:-1.2', ...Array(10).fill([',:-0.5', ' no:-0.5']).flat(), '.:-0.3']);
    expect(deloop(dot).text).toBe(' Oh, no');
  });

  it('cuts a text that was cut off where its first loop starts', () => {
    const loop = Array(9).fill([' and:-0.1', ' we:-0.1']).flat();
    const d = decodeOf([...sure(' We left'), ...loop, ...sure(' and then it was over')], { end: null });
    expect(deloop(d).text).toBe(' We left and we');
  });

  it('cuts at the second copy of a sentence Whisper never got out of', () => {
    const said = sure(' It was a good day.');
    const out = deloop(decodeOf([...sure(' We left.'), ...said, ...said, ...sure(' We left.'), ...said]));
    expect(out.text).toBe(' We left. It was a good day.');
    expect(out.endLogprob).toBeNull();
  });
});

describe('sentences', () => {
  const text = (parts: string[]) =>
    sentences(decodeOf(parts.map((p) => `${p}:-0.1`)).tokens).map((s) => s.map((t) => t.text).join(''));

  it('ends none at a dot inside a word or number', () => {
    // As Whisper's tokenizer writes them.
    expect(
      text([
        ' We',
        ' are',
        ' done',
        '.',
        ' Sub',
        'tit',
        'les',
        ' by',
        ' the',
        ' Am',
        'ara',
        '.',
        'org',
        ' community',
      ]),
    ).toEqual([' We are done.', ' Subtitles by the Amara.org community']);
    expect(text([' Редактор', ' субтитров', ' А', '.', 'Син', 'ецкая'])).toEqual([
      ' Редактор субтитров А.Синецкая',
    ]);
    expect(text([' It', ' rose', ' 3', '.', '5', '%.', ' Then', ' it', ' fell', '.'])).toEqual([
      ' It rose 3.5%.',
      ' Then it fell.',
    ]);
  });

  it('still ends Chinese and Japanese sentences', () => {
    expect(text(['我们', '走', '吧', '。', '好', '的', '。'])).toEqual(['我们走吧。', '好的。']);
    expect(text(['谢谢', '.', '好', '的'])).toEqual(['谢谢.', '好的']);
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

  it('drops an Amara.org credit as Whisper tokenizes it', () => {
    const credit = [' Sub', 'tit', 'les', ' by', ' the', ' Am', 'ara', '.', 'org', ' community'].map(
      (t) => `${t}:-0.9`,
    );
    expect(stripHallucinationPhrases(decodeOf([...sure(' We are done.'), ...credit]))).toBe(' We are done.');
    expect(stripHallucinationPhrases(decodeOf(credit))).toBe('');
    const ru = [' Редактор', ' субтитров', ' А', '.', 'Син', 'ецкая'].map((t) => `${t}:-0.9`);
    expect(stripHallucinationPhrases(decodeOf([...sure(' Всё.'), ...ru]))).toBe(' Всё.');
  });

  it('looks past a sound tag after the phrase', () => {
    const outro = [' Thanks:-0.9', ' for:-0.9', ' watching:-0.9', '!:-0.9'];
    for (const tag of [' ♪', ' [Music]', ' (upbeat music)']) {
      expect(stripHallucinationPhrases(decodeOf([...sure(' We are done.'), ...outro, `${tag}:-0.5`]))).toBe(
        ' We are done.',
      );
    }
    expect(stripHallucinationPhrases(decodeOf([...sure(' We are done.'), ' [Music]:-0.5']))).toBe(
      ' We are done. [Music]',
    );
  });

  it('keeps "And you?": only a lone "you" is the hallucination', () => {
    expect(isHallucinationPhrase(' And you?')).toBe(false);
    expect(isHallucinationPhrase(' Okay, and you?')).toBe(false);
    expect(isHallucinationPhrase(' You.')).toBe(true);
    const asked = decodeOf([...sure(" I'm fine, thanks."), ' And:-0.2', ' you:-0.1', '?:-0.8']);
    expect(stripHallucinationPhrases(asked)).toBe(" I'm fine, thanks. And you?");
  });

  it('knows the Korean outro without its space and the Arabic one', () => {
    expect(isHallucinationPhrase('시청해주셔서 감사합니다.')).toBe(true);
    expect(isHallucinationPhrase('شكرا للمشاهدة')).toBe(true);
    expect(isHallucinationPhrase('شكراً للمشاهدة.')).toBe(true);
  });
});

describe('maxClipTokens', () => {
  it('is tight in compact scripts and generous in scripts that take several tokens per character', () => {
    expect(maxClipTokens(3, 'en')).toBe(68);
    expect(maxClipTokens(3, 'ru')).toBe(68);
    expect(maxClipTokens(3, 'zh')).toBe(68);
    expect(maxClipTokens(3, 'hi')).toBe(164);
    expect(maxClipTokens(15.19, 'hi')).toBe(440); // the fast Hindi clip that needed 308 tokens
    expect(maxClipTokens(28, 'en')).toBe(440);
  });
});

describe('transcribeChecked', () => {
  const run = async (first: ClipDecode, second?: ClipDecode, whole?: ClipDecode) => {
    const calls: boolean[] = [];
    const verdict = await transcribeChecked(async (timestamps, wholeBudget) => {
      calls.push(timestamps);
      if (wholeBudget && !timestamps) return whole!;
      return timestamps ? second! : first;
    }, 3);
    return { ...verdict, calls };
  };

  it('decodes a text the token limit cut off again with the whole budget, not with timestamps', async () => {
    const calls: [boolean, boolean][] = [];
    const words = sure(' पिछली बार कुछ गलतियाँ रह गई थीं, इस बार ध्यान से देखना।');
    const v = await transcribeChecked(async (timestamps, wholeBudget) => {
      calls.push([timestamps, wholeBudget]);
      return wholeBudget ? decodeOf(words) : decodeOf(words.slice(0, 4), { truncated: true });
    }, 15);
    expect(calls).toEqual([
      [false, false],
      [false, true],
    ]);
    expect(v).toMatchObject({
      text: 'पिछली बार कुछ गलतियाँ रह गई थीं, इस बार ध्यान से देखना।',
      partial: false,
    });
  });

  it('never keeps a character the cut split', async () => {
    const vocab = new Map<string, number>();
    const cut = decodeOf([' पिछली:-0.1', ' बार:-0.1', ' क:-0.1', '�:-0.1'], { truncated: true, vocab });
    const v = await run(cut, cut, cut);
    expect(v.text).toBe('पिछली बार क');
    expect(v.partial).toBe(true);
  });

  it('keeps the speech after a sentence said three times', async () => {
    const thanks = sure(' Thank you so much.');
    const speech = decodeOf([
      ...thanks,
      ...thanks,
      ...thanks,
      ...sure(" It's an honour to be here tonight."),
    ]);
    expect(await run(speech)).toMatchObject({
      text: "Thank you so much. Thank you so much. Thank you so much. It's an honour to be here tonight.",
      retried: false,
    });
  });

  it('keeps the speech after a repetition Whisper got out of', async () => {
    // As decodeScored leaves it after the loop guard's ban: the chant in full, then the rest.
    const go = decodeOf([
      ' Go:-0.3',
      '!:-0.2',
      ...Array(9).fill([' Go:-0.1', '!:-0.1']).flat(),
      ...sure(' Come on, run.'),
    ]);
    const v = await run(go, go);
    expect(v).toMatchObject({ text: 'Go! Come on, run.', retried: true, partial: false });
  });

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

describe('collapseRepeats in other scripts', () => {
  it('collapses loops in text written without spaces', () => {
    expect(collapseRepeats('谢谢'.repeat(12))).toBe('谢谢');
    expect(collapseRepeats('我们走吧，'.repeat(6))).toBe('我们走吧，');
    expect(collapseRepeats(`はい。${'ありがとうございます。'.repeat(6)}`)).toBe(
      'はい。ありがとうございます。',
    );
    expect(collapseRepeats('ขอบคุณครับ'.repeat(8))).toBe('ขอบคุณครับ');
    expect(collapseRepeats('𠮷'.repeat(9))).toBe('𠮷𠮷');
    // Latin text is unchanged.
    expect(collapseRepeats('thank you, '.repeat(6))).toBe('thank you,');
  });

  it('leaves ordinary repetition in those scripts alone', () => {
    for (const text of [
      '哈哈哈',
      'はいはいはい',
      '对对对对',
      '是的是的是的',
      '今日はいい天気ですね。そうですね。',
    ]) {
      expect(collapseRepeats(text)).toBe(text);
    }
  });

  it('tells words apart by their vowel signs', () => {
    // कम ("less") and काम ("work") differ only by the vowel sign ा: a two-word loop, not one word.
    expect(collapseRepeats('कम काम कम काम कम काम कम काम')).toBe('कम काम');
    expect(collapseRepeats('काम '.repeat(8))).toBe('काम');
  });
});

describe('cleanTranscript in other scripts', () => {
  it('drops full-width sound tags and music notes', () => {
    expect(cleanTranscript('（拍手）', 3)).toBe('');
    expect(cleanTranscript('【音楽】', 3)).toBe('');
    expect(cleanTranscript('［笑］', 3)).toBe('');
    expect(cleanTranscript('♪～', 3)).toBe('');
    expect(cleanTranscript('～♪ La la la ♪～', 3)).toBe('La la la');
  });

  it('keeps speech in parentheses but drops sound tags there', () => {
    expect(cleanTranscript('Il prezzo (in euro) è salito.', 5)).toBe('Il prezzo (in euro) è salito.');
    expect(cleanTranscript('2020年(令和2年)に始まった', 5)).toBe('2020年(令和2年)に始まった');
    expect(cleanTranscript('東京（とうきょう）に行きました。', 5)).toBe('東京（とうきょう）に行きました。');
    expect(cleanTranscript('So I said (laughs) no way.', 5)).toBe('So I said no way.');
    expect(cleanTranscript('(Risas) Sí, claro.', 5)).toBe('Sí, claro.');
    expect(cleanTranscript('That was great. (door closes)', 5)).toBe('That was great.');
    expect(cleanTranscript('(speaking in foreign language)', 5)).toBe('');
  });

  it('adds no space where a tag sat inside Chinese or Japanese', () => {
    expect(cleanTranscript('你好（笑）我们走吧', 5)).toBe('你好我们走吧');
    expect(cleanTranscript('そうですね[音楽]分かりました', 5)).toBe('そうですね分かりました');
  });

  it('leaves credits and outros to the hallucination filter, which drops them when Whisper is unsure', () => {
    for (const t of [
      'ご視聴ありがとうございました',
      '字幕由Amara.org社区提供',
      "Sous-titres réalisés par la communauté d'Amara.org",
      'Untertitel der Amara.org-Community',
      'Субтитры сделал DimaTorzok',
    ]) {
      expect(isHallucinationPhrase(t)).toBe(true);
      expect(cleanTranscript(t, 1.2)).toBe(t);
    }
    expect(stripHallucinationPhrases(decodeOf(['ご視聴:-0.9', 'ありがとうございました:-0.8']))).toBe('');
  });
});
