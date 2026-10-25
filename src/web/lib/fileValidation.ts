import { formatBytes } from '../../shared/time';

export interface FileProblem {
  code: 'UNSUPPORTED_FILE' | 'FILE_TOO_LARGE' | 'EMPTY_FILE';
  message: string;
}

export const FORMAT_LABELS = ['MP3', 'WAV', 'M4A', 'OGG', 'FLAC', 'WEBM'] as const;

/** Lower-case extension without the dot ("" when there is none). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Checks a file before uploading it; returns a user-facing problem or null when it's fine. */
export function validateAudioFile(
  file: File,
  opts: { maxBytes: number; acceptedExtensions: readonly string[] },
): FileProblem | null {
  if (!opts.acceptedExtensions.includes(fileExtension(file.name))) {
    return {
      code: 'UNSUPPORTED_FILE',
      message: `“${file.name}” isn’t a supported audio file. Upload an MP3, WAV, M4A, OGG, FLAC or WEBM file.`,
    };
  }
  if (file.size === 0) return { code: 'EMPTY_FILE', message: `“${file.name}” is empty.` };
  if (file.size > opts.maxBytes) {
    return {
      code: 'FILE_TOO_LARGE',
      message: `“${file.name}” is ${formatBytes(file.size)}. The maximum size is ${formatBytes(opts.maxBytes)}.`,
    };
  }
  return null;
}
