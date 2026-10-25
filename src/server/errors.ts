import { ERROR_HTTP_STATUS, ERROR_MESSAGES } from '../shared/errors';
import type { ApiErrorBody, ErrorCode, TranscriptError } from '../shared/types';

/** An error with a stable code that maps to an HTTP status and a user-facing message. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message?: string, options?: { detail?: string; status?: number; cause?: unknown }) {
    super(message ?? ERROR_MESSAGES[code], { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options?.status ?? ERROR_HTTP_STATUS[code];
    this.detail = options?.detail;
  }

  toBody(): ApiErrorBody {
    return {
      error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) },
    };
  }

  toTranscriptError(): TranscriptError {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
