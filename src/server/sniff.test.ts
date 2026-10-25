import { makeWav } from '../../tests/server/wav';
import { SNIFF_BYTES, sniffContainer } from './sniff';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(Buffer.from(text, 'latin1'));

describe('sniffContainer', () => {
  it('recognises every accepted container', () => {
    expect(sniffContainer(ascii('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00'))).toBe('mp3');
    expect(sniffContainer(bytes(0xff, 0xfb, 0x90, 0x64))).toBe('mp3'); // MPEG-1 Layer III frame
    expect(sniffContainer(bytes(0xff, 0xe3, 0x18, 0xc4))).toBe('mp3'); // MPEG-2.5 frame
    expect(sniffContainer(makeWav({ seconds: 0.1 }))).toBe('wav');
    expect(sniffContainer(ascii('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00'))).toBe('mp4');
    expect(sniffContainer(ascii('\x00\x00\x00\x18ftypisom'))).toBe('mp4');
    expect(sniffContainer(ascii('OggS\x00\x02\x00\x00\x00\x00\x00\x00'))).toBe('ogg');
    expect(sniffContainer(ascii('fLaC\x00\x00\x00\x22\x10\x00\x10\x00'))).toBe('flac');
    expect(sniffContainer(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81))).toBe(
      'webm',
    );
  });

  it('needs no more than SNIFF_BYTES', () => {
    expect(sniffContainer(makeWav({ seconds: 1 }).subarray(0, SNIFF_BYTES))).toBe('wav');
  });

  it('rejects other content', () => {
    expect(sniffContainer(ascii('Hello, this is plain text'))).toBeNull();
    expect(sniffContainer(ascii('%PDF-1.7\n%âãÏÓ'))).toBeNull();
    expect(sniffContainer(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBeNull(); // PNG
    expect(sniffContainer(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull(); // JPEG: 0xFF but no frame sync
    expect(sniffContainer(ascii('RIFF\x00\x00\x00\x00AVI LIST'))).toBeNull(); // RIFF but not WAVE
    expect(sniffContainer(ascii('PK\x03\x04'))).toBeNull();
  });

  it('handles truncated input without reading past the end', () => {
    expect(sniffContainer(new Uint8Array())).toBeNull();
    expect(sniffContainer(bytes(0xff))).toBeNull();
    expect(sniffContainer(ascii('RIFF\x00\x00\x00\x00WAV'))).toBeNull();
    expect(sniffContainer(ascii('fLaC'))).toBe('flac');
  });
});
