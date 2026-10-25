import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ProviderError } from './types';

/** Streams a file from disk as a fetch body without loading it into memory. */
export function fileBody(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(path)) as ReadableStream<Uint8Array>;
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Removes a secret from text that will be logged or shown, just in case a provider echoes it. */
export function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

const MAX_DETAIL = 500;

/**
 * Extracts the provider's error message from a failed response: JSON `error`, `err_msg`,
 * `message` or `detail` fields, else the raw text. Truncated to keep it presentable.
 */
export async function readErrorDetail(res: Response): Promise<string | undefined> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  let detail = text;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const candidate = body.error ?? body.err_msg ?? body.message ?? body.detail;
    if (typeof candidate === 'string') detail = candidate;
    else if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { message?: unknown }).message === 'string'
    ) {
      detail = (candidate as { message: string }).message;
    }
  } catch {
    // Not JSON; use the text as is.
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
}

export interface ClassifyOptions {
  /** Provider name for messages, e.g. "AssemblyAI". */
  label: string;
  apiKey?: string;
  /** Whether the provider-side job survives this error (true while polling an existing job). */
  jobStillValid?: boolean;
}

/** Maps a non-2xx response to a ProviderError of the right kind. */
export async function errorFromResponse(res: Response, opts: ClassifyOptions): Promise<ProviderError> {
  const rawDetail = await readErrorDetail(res);
  const detail = rawDetail ? redact(rawDetail, opts.apiKey) : undefined;
  const status = res.status;
  const base = { status, detail, jobStillValid: opts.jobStillValid ?? false };
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `${opts.label} rejected the API key (HTTP ${status})`, base);
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new ProviderError('transient', `${opts.label} is temporarily unavailable (HTTP ${status})`, {
      ...base,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }
  return new ProviderError('failed', `${opts.label} could not process the request (HTTP ${status})`, base);
}

export interface FetchOptions extends ClassifyOptions {
  /** Per-request timeout; omit for long uploads (the job's own signal still applies). */
  timeoutMs?: number;
  signal: AbortSignal;
}

/**
 * fetch() that turns network failures and timeouts into transient ProviderErrors and
 * non-2xx responses into classified ProviderErrors. If the caller's signal aborts, the
 * abort propagates unchanged so the worker can tell "cancelled" apart from "failed".
 */
export async function providerFetch(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  const signal = opts.timeoutMs
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
    : opts.signal;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (opts.signal.aborted) throw opts.signal.reason ?? err;
    const timedOut = (err as Error)?.name === 'TimeoutError';
    throw new ProviderError(
      'transient',
      timedOut ? `${opts.label} did not respond in time` : `Could not reach ${opts.label}`,
      {
        detail: redact((err as Error)?.message ?? String(err), opts.apiKey),
        jobStillValid: opts.jobStillValid ?? false,
        cause: err,
      },
    );
  }
  if (!res.ok) throw await errorFromResponse(res, opts);
  return res;
}

/** Parses a JSON response body, treating malformed bodies as transient errors. */
export async function readJson<T>(res: Response, opts: ClassifyOptions): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ProviderError('transient', `${opts.label} returned an unreadable response`, {
      jobStillValid: opts.jobStillValid ?? false,
      cause: err,
    });
  }
}
