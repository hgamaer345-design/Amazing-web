// Clean-up of Whisper's text for one clip.

/** Whisper's usual output for non-speech: sound tags ("[Music]", "(laughs)", "♪") and nothing else. */
const SOUND_TAGS = /\[[^\]]*\]|\([^)]*\)|♪+/g;

/**
 * Collapses Whisper's repetition loops to one copy: a phrase of 2+ words repeated 4+ times in a
 * row, or a single word repeated 8+ times ("Ah, ah, ah, …" on a laugh). Ordinary repetition
 * ("no, no, no", "very very very very good") is left alone.
 */
export function collapseRepeats(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  for (let n = 1; n <= 8; n++) {
    const minReps = n === 1 ? 8 : 4;
    for (let i = 0; i + n * minReps <= words.length; i++) {
      let reps = 1;
      while (
        i + (reps + 1) * n <= words.length &&
        words.slice(i, i + n).every((w, k) => key(w) === key(words[i + reps * n + k]!))
      ) {
        reps++;
      }
      if (reps >= minReps) words.splice(i + n, (reps - 1) * n);
    }
  }
  return words.join(' ');
}

/** Cleans Whisper's text for a clip: drops sound tags, lone "you" hallucinations and loops. */
export function cleanTranscript(text: string, clipSeconds: number): string {
  let out = text.replace(SOUND_TAGS, ' ').replace(/\s+/g, ' ').trim();
  // A lone "you" on a very short clip is Whisper's classic output for a breath or a noise.
  if (clipSeconds < 2 && /^you[.!]?$/i.test(out)) out = '';
  return collapseRepeats(out);
}
