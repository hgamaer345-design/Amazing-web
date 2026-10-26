import { vi } from 'vitest';
import { uploadTranscript, type UploadOptions } from './api';

class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: unknown } = { onprogress: null };
  url = '';
  body: FormData | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send(body: FormData) {
    this.body = body;
    FakeXhr.last = this;
  }
  abort() {}
}

beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));
afterEach(() => vi.unstubAllGlobals());

const file = new File(['x'], 'call.wav', { type: 'audio/wav' });
const options: UploadOptions = { speakersExpected: null, keepAudio: false, clientDurationSec: null };

describe('uploadTranscript', () => {
  it('sends the chosen language before the file', () => {
    uploadTranscript(file, { ...options, language: 'ja' }, () => {});
    const form = FakeXhr.last!.body!;
    expect(form.get('language')).toBe('ja');
    const fields = [...form.keys()];
    expect(fields.indexOf('language')).toBeLessThan(fields.indexOf('file'));
  });

  it('leaves the language out to have it detected', () => {
    for (const language of [null, undefined]) {
      uploadTranscript(file, { ...options, language }, () => {});
      expect(FakeXhr.last!.body!.has('language')).toBe(false);
    }
  });
});
