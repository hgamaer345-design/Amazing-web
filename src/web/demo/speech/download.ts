// Downloads of model files served by this site, with byte progress, kept in the Cache API so later
// visits start straight away.

export type ByteProgress = (loaded: number, total: number) => void;

const CACHE_NAME = 'speaker-transcriber-models-v1';

/** Fetches a file with byte progress, keeping a copy in the Cache API for next time. */
export async function fetchCached(url: string, onProgress: ByteProgress): Promise<Uint8Array> {
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE_NAME).catch(() => null) : null;
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
