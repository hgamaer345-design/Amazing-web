// Streaming multipart upload: the audio goes straight from the socket to a ".part" file (never
// buffered in memory), is checked while it streams (size limit, magic bytes) and validated
// once complete (duration via music-metadata). Every failure path removes the partial file.
import busboy from 'busboy';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import { DEFAULT_QUALITY_MODE, isQualityMode } from '../shared/quality';
import { formatBytes } from '../shared/time';
import { ACCEPTED_EXTENSIONS, type AcceptedExtension, type QualityMode } from '../shared/types';
import { AppError } from './errors';
import { truncateText } from './http-utils';
import { log } from './logger';
import { SNIFF_BYTES, sniffContainer } from './sniff';
import type { AudioStorage } from './storage';

/** Room for multipart boundaries, part headers and the small text fields on top of the file itself. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_TITLE_LENGTH = 200;
const MAX_FILENAME_LENGTH = 255;
// Anything longer than this is not a real measurement of a single recording.
const MAX_CLIENT_DURATION_SEC = 7 * 24 * 3600;
const UNTITLED = 'Untitled recording';

/** Content type for each accepted extension (stored when the browser sends none, and used for playback). */
export const AUDIO_CONTENT_TYPES: Record<AcceptedExtension, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

export interface UploadLimits {
  maxUploadBytes: number;
  maxSpeakers: number;
  /** Used when the form has no "quality" field. */
  defaultQuality?: QualityMode;
}

export interface ReceivedUpload {
  /** Generated name of the stored file (inside the storage directory). */
  fileName: string;
  originalFilename: string;
  /** Default transcript title: the file name without its extension. */
  title: string;
  extension: AcceptedExtension;
  mimeType: string;
  sizeBytes: number;
  /** From the file itself, or the browser's measurement when the file doesn't say. */
  durationSec: number | null;
  speakersExpected: number | null;
  keepAudio: boolean;
  quality: QualityMode;
}

interface UploadFields {
  speakersExpected: number | null;
  keepAudio: boolean;
  clientDurationSec: number | null;
  quality: QualityMode;
}

interface PartFile {
  partName: string;
  finalName: string;
  originalFilename: string;
  extension: AcceptedExtension;
  mimeType: string;
  bytes: number;
  /** Settles once the ".part" file is completely written (or the write failed). */
  written: Promise<void>;
  /**
   * Resolves once the ".part" file's descriptor is closed. A pipeline can fail before the file has
   * even been opened; deleting it before this point would race with its creation.
   */
  closed: Promise<void>;
}

// ---------------------------------------------------------------------------
// Field and file-name helpers
// ---------------------------------------------------------------------------

/** Replaces control characters with spaces and trims. */
export function normalizeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** "Team call.final.MP3" -> "Team call.final" (max 200 chars), or a placeholder when nothing is left. */
export function titleFromFilename(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = normalizeTitle(dot >= 0 ? fileName.slice(0, dot) : fileName);
  return truncateText(base, MAX_TITLE_LENGTH).trim() || UNTITLED;
}

/** Lower-case accepted extension of a file name, or null. */
export function acceptedExtension(fileName: string): AcceptedExtension | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext) ? (ext as AcceptedExtension) : null;
}

function cleanFilename(raw: string): string {
  // Old browsers send a full client-side path; busboy strips it, but be defensive about "\".
  const name = normalizeTitle((raw.split(/[\\/]/).pop() ?? '').normalize('NFC'));
  if (name.length <= MAX_FILENAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return truncateText(name.slice(0, name.length - ext.length), MAX_FILENAME_LENGTH - ext.length) + ext;
}

/** The browser's MIME type when it is a plausible audio type, else the default for the extension. */
function storedMimeType(sent: string | undefined, extension: AcceptedExtension): string {
  const type = (sent ?? '').trim().toLowerCase();
  if (/^(audio|video)\/[a-z0-9][a-z0-9.+-]{0,62}$/.test(type) || type === 'application/ogg') return type;
  return AUDIO_CONTENT_TYPES[extension];
}

export function parseSpeakersExpected(value: string, maxSpeakers: number): number | null {
  const v = value.trim();
  if (v === '') return null;
  const n = /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= 1 && n <= maxSpeakers)) {
    throw new AppError(
      'INVALID_INPUT',
      `The number of speakers must be a whole number from 1 to ${maxSpeakers}, or left blank to detect it automatically.`,
    );
  }
  return n;
}

export function parseKeepAudio(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  throw new AppError('INVALID_INPUT', 'keepAudio must be "true" or "false".');
}

/**
 * The duration the browser measured. It is only a fallback hint (some browsers report 0 or
 * nonsense for files they can't decode), so an unusable value is ignored rather than rejected.
 */
export function parseClientDuration(value: string): number | null {
  const v = value.trim();
  const n = v === '' ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 && n <= MAX_CLIENT_DURATION_SEC ? n : null;
}

/** "standard" | "high" | "ultra"; anything else is rejected. */
export function parseQuality(value: string): QualityMode {
  const v = value.trim().toLowerCase();
  if (isQualityMode(v)) return v;
  throw new AppError('INVALID_INPUT', 'quality must be "standard", "high" or "ultra".');
}

function applyField(fields: UploadFields, name: string, value: string, maxSpeakers: number): void {
  switch (name) {
    case 'quality':
      fields.quality = parseQuality(value);
      break;
    case 'speakersExpected':
      fields.speakersExpected = parseSpeakersExpected(value, maxSpeakers);
      break;
    case 'keepAudio':
      fields.keepAudio = parseKeepAudio(value);
      break;
    case 'clientDurationSec':
      fields.clientDurationSec = parseClientDuration(value);
      break;
    default:
    // Unknown fields are ignored so older/newer clients keep working.
  }
}

export function fileTooLarge(maxUploadBytes: number): AppError {
  return new AppError(
    'FILE_TOO_LARGE',
    `This file is too large. The maximum size is ${formatBytes(maxUploadBytes)}.`,
  );
}

function multipartError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  if (/unexpected end of (form|file)/i.test(message)) return new AppError('UPLOAD_ABORTED');
  return new AppError('INVALID_INPUT', 'The upload could not be read. Please try again.', {
    detail: message,
  });
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Pass-through that counts bytes and rejects content that isn't an accepted audio container. */
function sniffAndCount(part: PartFile) {
  const check = (head: Buffer) => {
    if (!sniffContainer(head)) {
      throw new AppError('UNSUPPORTED_FILE', undefined, {
        detail: `The content of "${part.originalFilename}" is not a recognised audio format.`,
      });
    }
  };
  return async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let head: Buffer | null = Buffer.alloc(0);
    for await (const chunk of source) {
      part.bytes += chunk.length;
      if (!head) {
        yield chunk;
        continue;
      }
      head = Buffer.concat([head, chunk]);
      if (head.length >= SNIFF_BYTES) {
        check(head);
        yield head;
        head = null;
      }
    }
    // Files shorter than SNIFF_BYTES; an empty file is reported as EMPTY_FILE later.
    if (head && head.length > 0) {
      check(head);
      yield head;
    }
  };
}

/**
 * Parses the multipart body, writing the file part to "<uuid>.<ext>.part". Resolves once the body
 * has been fully read and the file fully written. On failure the partial file is deleted before
 * the promise rejects, and the rest of the request body is discarded.
 */
function receiveMultipart(
  req: IncomingMessage,
  storage: AudioStorage,
  limits: UploadLimits,
): Promise<{ fields: UploadFields; file: PartFile }> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        // Browsers send non-ASCII file names as raw UTF-8.
        defParamCharset: 'utf8',
        limits: {
          // busboy reports "limit" as soon as this many bytes arrived, so allow one more: a file of
          // exactly maxUploadBytes is fine, and "limit" means it is really over.
          fileSize: limits.maxUploadBytes + 1,
          files: 1,
          fields: 10,
          fieldSize: 1024,
          parts: 12,
          headerPairs: 50,
        },
      });
    } catch {
      reject(new AppError('NO_FILE', undefined, { detail: 'Expected a multipart/form-data request.' }));
      return;
    }

    const fields: UploadFields = {
      speakersExpected: null,
      keepAudio: false,
      clientDurationSec: null,
      quality: limits.defaultQuality ?? DEFAULT_QUALITY_MODE,
    };
    const abortWrite = new AbortController();
    let file: PartFile | null = null;
    let settled = false;

    const detach = () => {
      req.off('close', onRequestClose);
      req.off('error', onRequestError);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      req.unpipe(bb);
      req.resume();
      abortWrite.abort();
      const part = file;
      const removed = part
        ? part.written
            .catch(() => undefined)
            .then(() => part.closed)
            .then(() => storage.delete(part.partName))
        : Promise.resolve();
      removed
        .catch((cleanupErr: unknown) =>
          log.warn('Could not remove partial upload', { file: part?.partName, err: cleanupErr }),
        )
        .finally(() => reject(err));
    };

    const onRequestClose = () => {
      if (!req.complete) fail(new AppError('UPLOAD_ABORTED'));
    };
    const onRequestError = () => fail(new AppError('UPLOAD_ABORTED'));
    req.on('close', onRequestClose);
    req.on('error', onRequestError);

    bb.on('field', (name, value, info) => {
      if (settled) return;
      if (info.nameTruncated || info.valueTruncated) {
        fail(new AppError('INVALID_INPUT', undefined, { detail: `The form field "${name}" is too long.` }));
        return;
      }
      try {
        applyField(fields, name, value, limits.maxSpeakers);
      } catch (err) {
        fail(err);
      }
    });

    bb.on('file', (name, stream, info) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (name !== 'file') {
        stream.resume();
        fail(new AppError('INVALID_INPUT', 'Send the audio file in the form field named "file".'));
        return;
      }
      const originalFilename = cleanFilename(info.filename ?? '');
      if (!originalFilename) {
        stream.resume();
        fail(new AppError('NO_FILE'));
        return;
      }
      const extension = acceptedExtension(originalFilename);
      if (!extension) {
        stream.resume();
        fail(
          new AppError('UNSUPPORTED_FILE', undefined, {
            detail: `"${originalFilename}" does not have a supported file extension.`,
          }),
        );
        return;
      }
      const finalName = storage.newFileName(extension);
      const out = fs.createWriteStream(storage.absPath(`${finalName}.part`), { flags: 'wx' });
      const part: PartFile = {
        partName: `${finalName}.part`,
        finalName,
        originalFilename,
        extension,
        mimeType: storedMimeType(info.mimeType, extension),
        bytes: 0,
        written: Promise.resolve(),
        closed: new Promise((resolve) => out.once('close', () => resolve())),
      };
      stream.once('limit', () => fail(fileTooLarge(limits.maxUploadBytes)));
      part.written = pipeline(stream, sniffAndCount(part), out, { signal: abortWrite.signal });
      part.written.catch(fail);
      file = part;
    });

    bb.on('filesLimit', () => fail(new AppError('INVALID_INPUT', 'Upload one file at a time.')));
    bb.on('fieldsLimit', () =>
      fail(new AppError('INVALID_INPUT', undefined, { detail: 'Too many form fields.' })),
    );
    bb.on('partsLimit', () =>
      fail(new AppError('INVALID_INPUT', undefined, { detail: 'Too many form parts.' })),
    );
    bb.on('error', (err: unknown) => fail(multipartError(err)));
    bb.on('finish', () => {
      if (settled) return;
      const part = file;
      if (!part) {
        fail(new AppError('NO_FILE'));
        return;
      }
      Promise.all([part.written, part.closed]).then(() => {
        if (settled) return;
        settled = true;
        detach();
        resolve({ fields, file: part });
      }, fail);
    });

    req.pipe(bb);
  });
}

/**
 * Checks that the file parses as audio and returns its duration in seconds, or null when the
 * container doesn't record one (common for WEBM from MediaRecorder).
 */
async function readDuration(filePath: string): Promise<number | null> {
  let format: IAudioMetadata['format'];
  try {
    // Parsed under its ".part" name, which has no known extension, so music-metadata picks the parser
    // from the content: a file whose extension doesn't match its container still parses correctly.
    format = (await parseFile(filePath, { duration: true })).format;
  } catch (err) {
    log.info('Uploaded file could not be parsed as audio', {
      error: err instanceof Error ? err.name : 'Error',
    });
    throw new AppError('UNREADABLE_AUDIO', undefined, { cause: err });
  }
  // music-metadata is lenient: a valid container header followed by garbage "parses" without
  // yielding a single audio property. Real audio always has at least one of these.
  if (!format.codec && !format.sampleRate && !format.numberOfChannels) {
    throw new AppError('UNREADABLE_AUDIO', undefined, { detail: 'No audio stream was found in the file.' });
  }
  const { duration } = format;
  return duration != null && Number.isFinite(duration) && duration > 0 ? duration : null;
}

/**
 * Receives an audio upload (see "POST /api/transcripts" in docs/ARCHITECTURE.md) and stores it
 * under a generated name. Throws an AppError for every validation failure; nothing is left on
 * disk in that case. The caller owns the stored file once this resolves.
 */
export async function receiveUpload(
  req: IncomingMessage,
  storage: AudioStorage,
  limits: UploadLimits,
): Promise<ReceivedUpload> {
  const declaredLength = Number(req.headers['content-length']);
  if (declaredLength > limits.maxUploadBytes + MULTIPART_OVERHEAD_BYTES)
    throw fileTooLarge(limits.maxUploadBytes);

  const { fields, file } = await receiveMultipart(req, storage, limits);
  const partPath = storage.absPath(file.partName);
  try {
    if (file.bytes === 0) throw new AppError('EMPTY_FILE');
    const parsedDuration = await readDuration(partPath);
    await fsp.rename(partPath, storage.absPath(file.finalName));
    return {
      fileName: file.finalName,
      originalFilename: file.originalFilename,
      title: titleFromFilename(file.originalFilename),
      extension: file.extension,
      mimeType: file.mimeType,
      sizeBytes: file.bytes,
      durationSec: parsedDuration ?? fields.clientDurationSec,
      speakersExpected: fields.speakersExpected,
      keepAudio: fields.keepAudio,
      quality: fields.quality,
    };
  } catch (err) {
    await Promise.all([storage.delete(file.partName), storage.delete(file.finalName)]).catch(
      (cleanupErr: unknown) =>
        log.warn('Could not remove rejected upload', { file: file.partName, err: cleanupErr }),
    );
    throw err;
  }
}
