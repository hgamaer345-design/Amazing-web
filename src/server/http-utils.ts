import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { ErrorCode } from '../shared/types';
import { AppError, isAppError } from './errors';
import { log } from './logger';

/**
 * How long to keep reading (and discarding) a request body after an early error response
 * before dropping the connection. Closing a socket that still has unread upload data makes
 * the client's TCP stack reset the connection, and browsers then often report a network
 * error instead of showing our response; lingering briefly lets them read it first
 * (the same idea as nginx's lingering close). Bounded so a rejected 2 GB upload isn't
 * received in full.
 */
export const BODY_LINGER_MS = 10_000;

/**
 * Once the response has been sent, discards whatever is left of the request body and drops the
 * connection if the body still hasn't ended after `lingerMs`. Call this at the start of handlers
 * that may reject a large body before (fully) reading it.
 */
export function discardBodyAfterResponse(req: Request, res: Response, lingerMs = BODY_LINGER_MS): void {
  res.once('finish', () => {
    if (req.complete || req.destroyed) return;
    req.unpipe();
    req.resume();
    const timer = setTimeout(() => req.socket.destroy(), lingerMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    req.once('end', clear);
    req.once('close', clear);
  });
}

// ---------------------------------------------------------------------------
// Download file names
// ---------------------------------------------------------------------------

const MAX_DOWNLOAD_BASE_LENGTH = 150;

/** Truncates to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * "<title>.<ext>" with characters that are invalid in file names on common systems replaced,
 * e.g. 'Interview: A/B' + 'csv' -> 'Interview_ A_B.csv'. Falls back to "transcript".
 */
export function downloadFileName(title: string, extension: string): string {
  const base = truncateText(
    title
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, ''),
    MAX_DOWNLOAD_BASE_LENGTH,
  ).trim();
  return `${base || 'transcript'}.${extension}`;
}

/** Percent-encodes a value for an RFC 5987 `ext-value` (only attr-chars stay literal). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition: attachment` with a plain-ASCII `filename` for old clients plus the exact
 * UTF-8 name in `filename*` (RFC 6266 / RFC 5987), which modern browsers prefer.
 */
export function attachmentDisposition(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const toAscii = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]|["\\%]/g, '_')
      .replace(/_{2,}/g, '_');
  const asciiBase = toAscii(base).trim();
  const fallback = `${/[A-Za-z0-9]/.test(asciiBase) ? asciiBase : 'transcript'}${toAscii(ext)}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  type?: unknown;
  headers?: unknown;
}

function httpStatusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as HttpErrorLike;
  const status =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
  return status != null && Number.isInteger(status) && status >= 400 && status < 600 ? status : null;
}

/**
 * Converts errors thrown by Express, body-parser (`express.json`) and `send` (`res.sendFile`) into
 * AppErrors. Only client errors (4xx) keep their status; anything else becomes a generic 500 so no
 * internal detail reaches the client.
 */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  const status = httpStatusOf(err);
  if (status == null || status >= 500 || (err as HttpErrorLike).expose === false)
    return new AppError('INTERNAL');
  switch ((err as HttpErrorLike).type) {
    case 'entity.parse.failed':
      return new AppError('INVALID_INPUT', 'The request body is not valid JSON.', { status: 400 });
    case 'entity.too.large':
      return new AppError('INVALID_INPUT', 'The request body is too large.', { status: 413 });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError('INVALID_INPUT', 'The request body uses an unsupported encoding.', { status: 415 });
    case 'request.aborted':
      return new AppError('UPLOAD_ABORTED', undefined, { status: 400 });
  }
  const code: ErrorCode = status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : 'INVALID_INPUT';
  return new AppError(code, undefined, { status });
}

/** Extra headers some library errors carry, e.g. `Content-Range` on a 416 from `send`. */
function errorHeaders(err: unknown): Record<string, string> {
  const headers = typeof err === 'object' && err !== null ? (err as HttpErrorLike).headers : undefined;
  if (typeof headers !== 'object' || headers === null) return {};
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Uniform JSON error responses (`ApiErrorBody`). Must be registered last. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  const appError = toAppError(err);
  if (appError.code === 'INTERNAL') {
    log.error('Request failed', { method: req.method, path: req.path, err });
  } else {
    log.debug('Request rejected', { method: req.method, path: req.path, code: appError.code });
  }
  if (res.headersSent) {
    // Too late for a JSON body; Express's default handler aborts the half-sent response.
    next(err);
    return;
  }
  res.removeHeader('Content-Disposition');
  res.set(errorHeaders(err));
  res.status(appError.status).type('application/json').json(appError.toBody());
};

/** JSON 404 for unknown API routes. */
export const apiNotFound: RequestHandler = (req, _res, next) => {
  next(
    new AppError('NOT_FOUND', 'Unknown API endpoint.', { detail: `${req.method} ${req.baseUrl}${req.path}` }),
  );
};
