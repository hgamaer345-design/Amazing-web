// Magic-byte detection of the audio containers the app accepts. Used on the first bytes of an
// upload so that a renamed non-audio file is rejected before it is stored or sent to a provider.

/** Container families we accept, independent of the file's extension. */
export type AudioContainer = 'mp3' | 'wav' | 'mp4' | 'ogg' | 'flac' | 'webm';

/** Number of leading bytes needed to recognise every supported container. */
export const SNIFF_BYTES = 12;

function hasAscii(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Identifies the container from the first bytes of a file (at least `SNIFF_BYTES` when available).
 * Returns null when the content is not one of the accepted formats.
 */
export function sniffContainer(head: Uint8Array): AudioContainer | null {
  // MP3 with an ID3v2 tag, or a bare MPEG audio frame (11 sync bits: 0xFF 0xE?/0xF?).
  if (hasAscii(head, 0, 'ID3')) return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  if (hasAscii(head, 0, 'RIFF') && hasAscii(head, 8, 'WAVE')) return 'wav';
  // ISO base media (M4A/MP4/AAC in MP4): the first box is "ftyp".
  if (hasAscii(head, 4, 'ftyp')) return 'mp4';
  if (hasAscii(head, 0, 'OggS')) return 'ogg';
  if (hasAscii(head, 0, 'fLaC')) return 'flac';
  // EBML header, shared by WEBM and Matroska.
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'webm';
  }
  return null;
}
