import type { ErrorCode } from '../shared/types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  /** Parsed response body, e.g. the latest document for VERSION_CONFLICT. */
  readonly body: unknown;

  constructor(code: ErrorCode, message: string, status: number, detail?: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}
