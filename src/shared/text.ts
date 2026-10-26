// Joining pieces of transcript text in any script.

/** Han, kana and full-width punctuation: scripts written without spaces between words. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿！-｠]/u;

/**
 * `a` and `b` joined as they would be written: with a space, except between two pieces of Chinese
 * or Japanese text ("我们今天讨论" + "然后再决定" has no space; Thai and Korean keep theirs).
 */
export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = [...a.trimEnd()].at(-1) ?? '';
  const first = [...b.trimStart()][0] ?? '';
  return NO_SPACE_SCRIPT.test(last) && NO_SPACE_SCRIPT.test(first)
    ? a.trimEnd() + b.trimStart()
    : `${a.trimEnd()} ${b.trimStart()}`;
}

/** All pieces joined with `joinText` (empty pieces skipped). */
export function joinTexts(pieces: readonly string[]): string {
  return pieces.reduce((out, p) => (p.trim() ? joinText(out, p) : out), '');
}
