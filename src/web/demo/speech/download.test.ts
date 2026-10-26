import { fakeServer, sha256 } from './__fixtures__/fakeModel';
import {
  fetchFiles,
  fetchManifest,
  modelUrl,
  parseManifest,
  pruneCache,
  type ManifestFile,
} from './download';

/** An in-memory Cache API. */
function fakeCaches() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (url: string) => store.get(url)?.clone(),
    put: async (url: string, res: Response) => void store.set(url, res),
    keys: async () => [...store.keys()].map((url) => new Request(url)),
    delete: async (req: Request) => store.delete(req.url),
  };
  return { caches: { open: async () => cache }, store };
}

const bytes = (...values: number[]) => Uint8Array.from(values);
const entry = (file: string, data: Uint8Array): ManifestFile => ({
  file,
  bytes: data.length,
  sha256: sha256(data),
});

describe('parseManifest', () => {
  const ok = {
    model: entry('model.a.onnx', bytes(1)),
    data: [entry('model.b.data', bytes(2))],
    tokens: entry('tokens.c.txt', bytes(3)),
  };

  it('accepts a manifest', () => {
    expect(parseManifest({ format: 1, ...ok })).toEqual(ok);
  });

  it.each([
    ['a missing part list', { ...ok, data: undefined }],
    ['a path outside the folder', { ...ok, model: { ...ok.model, file: '../model.onnx' } }],
    ['a sub-folder', { ...ok, data: [{ ...ok.data[0]!, file: 'x/model.b.data' }] }],
    ['a bad checksum', { ...ok, tokens: { ...ok.tokens, sha256: 'abc' } }],
    ['a negative size', { ...ok, model: { ...ok.model, bytes: -1 } }],
  ])('rejects %s', (_, manifest) => {
    expect(() => parseManifest(manifest)).toThrow(/Invalid model manifest/);
  });
});

describe('fetchFiles', () => {
  const base = 'http://localhost:3000/models/m/';
  const files = { 'a.data': bytes(1, 2, 3, 4, 5), 'b.data': bytes(6, 7, 8) };
  const list = Object.entries(files).map(([name, data]) => entry(name, data));
  afterEach(() => vi.unstubAllGlobals());

  it('downloads every file with byte progress over all of them', async () => {
    const server = fakeServer('models/m/', files);
    vi.stubGlobal('fetch', server.fetch);
    const progress: number[] = [];
    const out = await fetchFiles(base, list, (loaded, total) => {
      expect(total).toBe(8);
      progress.push(loaded);
    });
    expect(out.map((b) => Array.from(b))).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8],
    ]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(8);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('caches each file and uses the copy next time; a copy of the wrong size is replaced', async () => {
    const { caches, store } = fakeCaches();
    vi.stubGlobal('caches', caches);
    const server = fakeServer('models/m/', files);
    vi.stubGlobal('fetch', server.fetch);
    await fetchFiles(base, list, () => {});
    expect(server.requests).toHaveLength(2);
    store.set(`${base}b.data`, new Response(bytes(6, 7)));
    const again = await fetchFiles(base, list, () => {});
    expect(server.requests).toEqual(['/models/m/a.data', '/models/m/b.data', '/models/m/b.data']);
    expect(Array.from(again[1]!)).toEqual([6, 7, 8]);
  });

  it.each([
    ['incomplete', bytes(1, 2, 3, 4), /incomplete/],
    ['larger than expected', bytes(1, 2, 3, 4, 5, 6), /larger than expected/],
    ['corrupted', bytes(1, 2, 3, 4, 9), /corrupted/],
  ])('rejects a file that arrives %s, without caching it', async (_, served, error) => {
    const { caches, store } = fakeCaches();
    vi.stubGlobal('caches', caches);
    vi.stubGlobal('fetch', fakeServer('models/m/', { 'a.data': served }).fetch);
    await expect(fetchFiles(base, [list[0]!], () => {})).rejects.toThrow(error);
    expect(store.size).toBe(0);
  });

  it('reports a missing file', async () => {
    vi.stubGlobal('fetch', fakeServer('models/m/', {}).fetch);
    await expect(fetchFiles(base, [list[0]!], () => {})).rejects.toThrow(/Download failed \(404\)/);
  });
});

describe('fetchManifest', () => {
  afterEach(() => vi.unstubAllGlobals());
  const files = {
    'model.a.onnx': bytes(1),
    'model.b.data': bytes(2),
    'tokens.c.txt': bytes(3),
  };

  it('fetches the manifest from models/<dir>/ and falls back to the cached copy offline', async () => {
    const { caches } = fakeCaches();
    vi.stubGlobal('caches', caches);
    const server = fakeServer('models/sv/', files);
    vi.stubGlobal('fetch', server.fetch);
    const manifest = await fetchManifest('sv');
    expect(server.requests).toEqual(['/models/sv/manifest.json']);
    expect(manifest.data.map((f) => f.file)).toEqual(['model.b.data']);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchManifest('sv')).toEqual(manifest);
    await expect(fetchManifest('other')).rejects.toThrow(/Failed to fetch/);
  });

  it('rejects an invalid manifest', async () => {
    vi.stubGlobal('fetch', fakeServer('models/sv/', files, { model: 'x' }).fetch);
    await expect(fetchManifest('sv')).rejects.toThrow(/Invalid model manifest/);
  });
});

describe('pruneCache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes only the folder's files that the manifest no longer lists", async () => {
    const { caches, store } = fakeCaches();
    vi.stubGlobal('caches', caches);
    const base = modelUrl('sv/');
    for (const url of [`${base}manifest.json`, `${base}old.data`, `${base}new.data`, modelUrl('other.onnx')])
      store.set(url, new Response('x'));
    await pruneCache(base, ['manifest.json', 'new.data']);
    expect([...store.keys()]).toEqual([`${base}manifest.json`, `${base}new.data`, modelUrl('other.onnx')]);
  });
});
