// Typed client for the server API. All network access from the UI goes through here.
// In the static demo build (VITE_DEMO_MODE=true, e.g. GitHub Pages) every call is served
// by an in-browser simulation instead (see ./demo/demoApi.ts).
import { ERROR_MESSAGES } from '../shared/errors';
import type {
  ApiErrorBody,
  AppConfigResponse,
  CreateTranscriptResponse,
  ExportFormat,
  GetTranscriptResponse,
  ListTranscriptsResponse,
  QualityMode,
  SaveDocumentRequest,
  SaveDocumentResponse,
  TranscriptDetail,
  TranscriptDocument,
  TranscriptSummary,
  UpdateTranscriptResponse,
  UsageResponse,
} from '../shared/types';
import { ApiError } from './apiError';
import * as demo from './demo/demoApi';

export { ApiError };

/** True in the static demo build, which has no server. */
export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';

function isErrorBody(x: unknown): x is ApiErrorBody {
  return (
    typeof x === 'object' &&
    x !== null &&
    'error' in x &&
    typeof (x as ApiErrorBody).error?.code === 'string' &&
    typeof (x as ApiErrorBody).error?.message === 'string'
  );
}

function errorFromResponse(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    return new ApiError(body.error.code, body.error.message, status, body.error.detail, body);
  }
  if (status === 401) return new ApiError('UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED, status);
  if (status === 404) return new ApiError('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND, status);
  if (status === 413) return new ApiError('FILE_TOO_LARGE', ERROR_MESSAGES.FILE_TOO_LARGE, status);
  return new ApiError('INTERNAL', ERROR_MESSAGES.INTERNAL, status);
}

const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check your connection and try again.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('INTERNAL', NETWORK_ERROR_MESSAGE, 0);
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) throw errorFromResponse(res.status, body);
  return body as T;
}

export function getConfig(): Promise<AppConfigResponse> {
  if (isDemoMode) return demo.getConfig();
  return request<AppConfigResponse>('/api/config');
}

/** Today's use of limited quality modes (e.g. Ultra High's free daily uses) for this client. */
export function getUsage(): Promise<UsageResponse> {
  if (isDemoMode) return demo.getUsage();
  return request<UsageResponse>('/api/usage');
}

export async function listTranscripts(): Promise<TranscriptSummary[]> {
  if (isDemoMode) return demo.listTranscripts();
  return (await request<ListTranscriptsResponse>('/api/transcripts')).transcripts;
}

export async function getTranscript(id: string): Promise<TranscriptDetail> {
  if (isDemoMode) return demo.getTranscript(id);
  return (await request<GetTranscriptResponse>(`/api/transcripts/${encodeURIComponent(id)}`)).transcript;
}

/**
 * Saves the edited document. On a version conflict this throws an ApiError with
 * code "VERSION_CONFLICT" whose `body.document` is the server's latest document.
 */
export async function saveDocument(id: string, req: SaveDocumentRequest): Promise<TranscriptDocument> {
  if (isDemoMode) return demo.saveDocument(id, req);
  return (
    await request<SaveDocumentResponse>(`/api/transcripts/${encodeURIComponent(id)}/document`, {
      method: 'PUT',
      body: JSON.stringify(req),
    })
  ).document;
}

export function conflictDocument(err: unknown): TranscriptDocument | null {
  if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
    const doc = (err.body as { document?: TranscriptDocument } | null)?.document;
    return doc ?? null;
  }
  return null;
}

export async function updateTranscript(id: string, changes: { title?: string }): Promise<TranscriptSummary> {
  if (isDemoMode) return demo.updateTranscript(id, changes);
  return (
    await request<UpdateTranscriptResponse>(`/api/transcripts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  ).transcript;
}

export async function deleteTranscript(id: string): Promise<void> {
  if (isDemoMode) return demo.deleteTranscript(id);
  await request<void>(`/api/transcripts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function deleteAudio(id: string): Promise<TranscriptSummary> {
  if (isDemoMode) return demo.deleteAudio(id);
  return (
    await request<{ transcript: TranscriptSummary }>(`/api/transcripts/${encodeURIComponent(id)}/audio`, {
      method: 'DELETE',
    })
  ).transcript;
}

export async function retryTranscript(id: string): Promise<TranscriptSummary> {
  if (isDemoMode) return demo.retryTranscript(id);
  return (
    await request<{ transcript: TranscriptSummary }>(`/api/transcripts/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    })
  ).transcript;
}

export function audioUrl(id: string): string {
  if (isDemoMode) return demo.audioUrl(id);
  return `/api/transcripts/${encodeURIComponent(id)}/audio`;
}

export function exportUrl(id: string, format: ExportFormat): string {
  return `/api/transcripts/${encodeURIComponent(id)}/export?format=${format}`;
}

/** Starts a file download of the transcript in `format`. */
export async function downloadExport(id: string, format: ExportFormat): Promise<void> {
  if (isDemoMode) return demo.downloadExport(id, format);
  const a = document.createElement('a');
  a.href = exportUrl(id, format);
  // The server sends Content-Disposition with the real file name.
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface UploadOptions {
  speakersExpected: number | null;
  keepAudio: boolean;
  /** Duration measured in the browser, used if the server can't read it from the file. */
  clientDurationSec: number | null;
  /** Defaults to "high" on the server. */
  quality?: QualityMode;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadHandle {
  promise: Promise<TranscriptSummary>;
  abort(): void;
}

/**
 * Uploads a file with progress events (XMLHttpRequest, because fetch has no upload progress).
 * Text fields are appended before the file so the server can read them before the file streams in.
 */
export function uploadTranscript(
  file: File,
  options: UploadOptions,
  onProgress: (p: UploadProgress) => void,
): UploadHandle {
  if (isDemoMode) return demo.uploadTranscript(file, options, onProgress);
  const xhr = new XMLHttpRequest();
  const promise = new Promise<TranscriptSummary>((resolve, reject) => {
    const form = new FormData();
    if (options.speakersExpected != null) form.append('speakersExpected', String(options.speakersExpected));
    form.append('keepAudio', options.keepAudio ? 'true' : 'false');
    if (options.quality) form.append('quality', options.quality);
    if (options.clientDurationSec != null && Number.isFinite(options.clientDurationSec)) {
      form.append('clientDurationSec', String(options.clientDurationSec));
    }
    form.append('file', file, file.name);

    xhr.open('POST', options.quality ? `/api/transcripts?quality=${options.quality}` : '/api/transcripts');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : file.size });
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((body as CreateTranscriptResponse).transcript);
      } else {
        reject(errorFromResponse(xhr.status, body));
      }
    };
    xhr.onerror = () => reject(new ApiError('UPLOAD_ABORTED', NETWORK_ERROR_MESSAGE, 0));
    xhr.onabort = () => reject(new ApiError('UPLOAD_ABORTED', 'Upload cancelled.', 0));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
