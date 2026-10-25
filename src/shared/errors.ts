import type { ErrorCode } from './types';

/** Default user-facing message for each error code. Servers may send a more specific message. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  NO_FILE: 'Choose an audio file to upload.',
  UNSUPPORTED_FILE:
    'This file type is not supported. Upload an MP3, WAV, M4A, OGG, FLAC, or WEBM audio file.',
  FILE_TOO_LARGE: 'This file is too large. The maximum size is 500 MB.',
  EMPTY_FILE: 'This file is empty.',
  UNREADABLE_AUDIO: 'This file could not be read as audio. It may be damaged or not actually an audio file.',
  UPLOAD_ABORTED: 'The upload was interrupted. Check your connection and try again.',
  INVALID_INPUT: 'Some of the information sent was invalid.',
  NOT_FOUND: 'This transcript could not be found. It may have been deleted.',
  NOT_READY: 'This transcript is not ready yet.',
  AUDIO_DELETED: 'The audio for this transcript was deleted from the server after processing.',
  VERSION_CONFLICT: 'This transcript was changed somewhere else. The latest version has been loaded.',
  PROVIDER_NOT_CONFIGURED:
    'Transcription is not set up on this server. An administrator needs to configure a speech-to-text API key.',
  PROVIDER_AUTH_FAILED:
    'The speech-to-text service rejected the server’s API key. An administrator needs to check the configuration.',
  TRANSCRIPTION_FAILED: 'Transcription failed. Please try again.',
  TRANSCRIPTION_TIMEOUT: 'Transcription took too long and was stopped. Please try again.',
  NO_SPEECH: 'No speech was detected in this audio.',
  CANNOT_RETRY:
    'This transcript cannot be retried because its audio is no longer stored. Upload the file again.',
  QUOTA_EXCEEDED:
    'You’ve used all of today’s free Ultra High transcriptions. Choose High or Standard, or try again tomorrow.',
  UNAUTHORIZED: 'You need to sign in to use this app.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
};

/** HTTP status used for each error code when it is returned directly by an API route. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  NO_FILE: 400,
  UNSUPPORTED_FILE: 415,
  FILE_TOO_LARGE: 413,
  EMPTY_FILE: 400,
  UNREADABLE_AUDIO: 422,
  UPLOAD_ABORTED: 400,
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  NOT_READY: 409,
  AUDIO_DELETED: 404,
  VERSION_CONFLICT: 409,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_AUTH_FAILED: 502,
  TRANSCRIPTION_FAILED: 502,
  TRANSCRIPTION_TIMEOUT: 504,
  NO_SPEECH: 422,
  CANNOT_RETRY: 409,
  QUOTA_EXCEEDED: 429,
  UNAUTHORIZED: 401,
  INTERNAL: 500,
};
