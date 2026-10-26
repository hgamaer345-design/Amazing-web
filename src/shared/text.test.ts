import { joinText, joinTexts } from './text';

describe('joinText', () => {
  it('uses a space between words of most scripts', () => {
    expect(joinText('Hello there.', 'How are you?')).toBe('Hello there. How are you?');
    expect(joinText('สวัสดีครับ', 'ยินดีที่ได้รู้จัก')).toBe('สวัสดีครับ ยินดีที่ได้รู้จัก');
    expect(joinText('안녕하세요.', '반갑습니다.')).toBe('안녕하세요. 반갑습니다.');
    expect(joinText('مرحبا', 'كيف حالك؟')).toBe('مرحبا كيف حالك؟');
  });

  it('joins Chinese and Japanese without a space', () => {
    expect(joinText('我们今天讨论这个问题', '然后再决定。')).toBe('我们今天讨论这个问题然后再决定。');
    expect(joinText('そうですね。', '分かりました。')).toBe('そうですね。分かりました。');
    expect(joinText('好的。 ', ' 谢谢。')).toBe('好的。谢谢。');
  });

  it('keeps a space where Latin text meets Chinese or Japanese', () => {
    expect(joinText('iPhone', '很好用')).toBe('iPhone 很好用');
  });

  it('skips empty pieces', () => {
    expect(joinText('', 'a')).toBe('a');
    expect(joinText('a', '')).toBe('a');
    expect(joinTexts(['今日は', '', ' ', 'いい天気です。', 'Yes.'])).toBe('今日はいい天気です。 Yes.');
  });
});
