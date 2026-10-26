// Downloads of model files served by this site, with byte progress, kept in the Cache API so later
// visits start straight away. Models over GitHub's 100 MB file limit are served in parts listed in
// a manifest (written by scripts/fetch-speech-models.mjs).

export type ByteProgress = (loaded: number, total: number) => void;

const CACHE_NAME = 'speaker-transcriber-models-v1';

function openCache(): Promise<Cache | null> {
  return typeof caches !== 'undefined' ? caches.open(CACHE_NAME).catch(() => null) : Promise.resolve(null);
}

/** Fetches a file with byte progress, keeping a copy in the Cache API for next time. */
export async function fetchCached(url: string, onProgress: ByteProgress): Promise<Uint8Array> {
  const cache = await openCache();
  const cached = await cache?.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    onProgress(bytes.length, bytes.length);
    return bytes;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress(loaded, Math.max(total, loaded));
  }
  const bytes = new Uint8Array(loaded);
  let pos = 0;
  for (const p of parts) {
    bytes.set(p, pos);
    pos += p.length;
  }
  await cache
    ?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    .catch(() => {});
  return bytes;
}

export function modelUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}models/${file}`, self.location.href).href;
}

/** A file listed in a model manifest. Names carry part of the checksum, so a cached copy is never stale. */
export interface ManifestFile {
  file: string;
  bytes: number;
  sha256: string;
}

/**
 * `<model folder>/manifest.json`: the model's graph, its weights as ONNX external data in parts
 * (the graph refers to each by its file name) and its token table.
 */
export interface ModelManifest {
  model: ManifestFile;
  data: ManifestFile[];
  tokens: ManifestFile;
}

function isManifestFile(value: unknown): value is ManifestFile {
  const f = value as ManifestFile | null;
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof f.file === 'string' &&
    /^[\w-][\w.-]*$/.test(f.file) &&
    Number.isSafeInteger(f.bytes) &&
    f.bytes >= 0 &&
    typeof f.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(f.sha256)
  );
}

export function parseManifest(value: unknown): ModelManifest {
  const m = value as ModelManifest | null;
  const ok =
    typeof m === 'object' &&
    m !== null &&
    isManifestFile(m.model) &&
    Array.isArray(m.data) &&
    m.data.every(isManifestFile) &&
    isManifestFile(m.tokens);
  if (!ok) throw new Error('Invalid model manifest');
  return { model: m.model, data: m.data, tokens: m.tokens };
}

/**
 * The manifest of the model in `models/<dir>/`, always checked with the server (it names the
 * current files); the copy from the last visit is used when the network is unavailable.
 */
export async function fetchManifest(dir: string): Promise<ModelManifest> {
  const url = modelUrl(`${dir}/manifest.json`);
  const cache = await openCache();
  let text: string;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    text = await res.text();
    await cache
      ?.put(url, new Response(text, { headers: { 'content-type': 'application/json' } }))
      .catch(() => {});
  } catch (err) {
    const cached = await cache?.match(url);
    if (!cached) throw err;
    text = await cached.text();
  }
  return parseManifest(JSON.parse(text));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  // SubtleCrypto needs a secure context (GitHub Pages and localhost are).
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Downloads `url` into a new array of exactly `file.bytes`, checking its size and checksum. */
async function download(
  url: string,
  file: ManifestFile,
  onBytes: (n: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const out = new Uint8Array(file.bytes);
  const reader = res.body.getReader();
  let pos = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (pos + value.length > out.length) {
      await reader.cancel().catch(() => {});
      throw new Error(`Download of ${file.file} is larger than expected`);
    }
    out.set(value, pos);
    pos += value.length;
    onBytes(pos);
  }
  if (pos !== out.length)
    throw new Error(`Download of ${file.file} is incomplete (${pos} of ${out.length} bytes)`);
  const hash = await sha256Hex(out);
  if (hash !== null && hash !== file.sha256) throw new Error(`Download of ${file.file} is corrupted`);
  return out;
}

/**
 * Fetches `files` (relative to `baseUrl`, a folder URL ending in "/"), one array each, with byte
 * progress over all of them. Each file is cached once its size and SHA-256 are right, so an
 * interrupted download resumes at the file where it stopped.
 */
export async function fetchFiles(
  baseUrl: string,
  files: readonly ManifestFile[],
  onProgress: ByteProgress,
): Promise<Uint8Array[]> {
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const cache = await openCache();
  const out: Uint8Array[] = [];
  let done = 0;
  onProgress(0, total);
  for (const file of files) {
    const url = new URL(file.file, baseUrl).href;
    const cached = await cache?.match(url);
    let bytes: Uint8Array<ArrayBuffer> | null = cached ? new Uint8Array(await cached.arrayBuffer()) : null;
    if (!bytes || bytes.length !== file.bytes) {
      const start = done;
      bytes = await download(url, file, (n) => onProgress(start + n, total));
      await cache
        ?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
        .catch(() => {});
    }
    out.push(bytes);
    done += file.bytes;
    onProgress(done, total);
  }
  return out;
}

/** Removes cached files of the folder at `baseUrl` that `keep` doesn't list (earlier versions). */
export async function pruneCache(baseUrl: string, keep: readonly string[]): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  const wanted = new Set(keep.map((f) => new URL(f, baseUrl).href));
  for (const request of await cache.keys().catch(() => [] as readonly Request[])) {
    if (request.url.startsWith(baseUrl) && !wanted.has(request.url))
      await cache.delete(request).catch(() => {});
  }
}
