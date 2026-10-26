// The build step that turns a model into the files the site serves (scripts/fetch-speech-models.mjs),
// and loading those files back the way the demo does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PART_BYTES,
  toExternalData,
  verifyExternalData,
  writeServedModel,
} from '../../../../scripts/fetch-speech-models.mjs';
import { encodeModel, fakeServer, readInitializers, sha256, type FakeTensor } from './__fixtures__/fakeModel';
import { fetchCtcModel, onnxMetadata } from './ctc';

const filled = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

const tensors: FakeTensor[] = [
  { name: 'w1', dims: [32, 64], raw: filled(2048, 1) },
  { name: 'scale', dims: [1], raw: filled(4, 2) },
  { name: 'w2', dims: [1500], raw: filled(1500, 3), explicitDefaultLocation: true },
  { name: 'bias', dims: [3], floats: [0.5, 1, 2] },
  { name: 'w3', dims: [1024], raw: filled(1024, 4) },
];
const model = encodeModel({ metadata: { lfr_window_size: '7', comment: 'test' }, tensors });

describe('toExternalData', () => {
  const split = () => toExternalData(model, 3000, (bytes) => `part.${sha256(bytes).slice(0, 8)}.data`);

  it('moves the weights into parts of at most the given size, the rest staying in the graph', () => {
    const { graph, parts } = split();
    // w1 alone; w2 and w3 together (w3 at the next 64-byte boundary after w2).
    expect(parts.map((p) => p.bytes.length)).toEqual([2048, 1536 + 1024]);
    const inits = readInitializers(graph);
    expect(inits.map((t) => [t.name, t.raw?.length ?? null, t.location])).toEqual([
      ['w1', null, 1],
      ['scale', 4, null],
      ['w2', null, 1],
      ['bias', null, null],
      ['w3', null, 1],
    ]);
    expect(inits[4]!.external).toEqual({ location: parts[1]!.name, offset: '1536', length: '1024' });
    for (const t of inits.filter((x) => x.location === 1)) {
      const part = parts.find((p) => p.name === t.external.location)!;
      const start = Number(t.external.offset);
      const original = tensors.find((x) => x.name === t.name)!.raw!;
      expect(part.bytes.subarray(start, start + Number(t.external.length))).toEqual(original);
    }
    expect(verifyExternalData(model, graph, parts)).toBe(3);
  });

  it('keeps the metadata and everything else in the graph file', () => {
    const { graph } = split();
    expect(onnxMetadata(graph)).toEqual({ lfr_window_size: '7', comment: 'test' });
    expect(graph.length).toBeLessThan(model.length - 4000);
  });

  it('notices a part that does not match the original', () => {
    const { graph, parts } = split();
    const part = parts[1]!.bytes;
    part[1600] = part[1600]! ^ 1;
    expect(() => verifyExternalData(model, graph, parts)).toThrow(/differs/);
  });

  it('refuses a tensor larger than a part', () => {
    expect(() => toExternalData(model, 2000, () => 'x')).toThrow(/exceeds the part size/);
  });
});

describe('writeServedModel', () => {
  it('writes files named by their checksum and a manifest the demo loads them with', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'served-model-'));
    try {
      const tokens = new TextEncoder().encode('<blk> 0\n▁a 1\n');
      const source = {
        url: 'https://example.com/m.tar.bz2',
        member: 'm/model.int8.onnx',
        sha256: sha256(model),
      };
      const manifest = writeServedModel(dir, model, tokens, source);
      expect(MAX_PART_BYTES).toBe(45_000_000);
      expect(manifest.source).toEqual(source);
      expect(manifest.data).toHaveLength(1);
      expect(manifest.model.file).toMatch(/^model\.[0-9a-f]{16}\.onnx$/);
      expect(manifest.tokens.file).toBe(`tokens.${sha256(tokens).slice(0, 16)}.txt`);
      const files = Object.fromEntries(
        fs
          .readdirSync(dir)
          .filter((f) => f !== 'manifest.json')
          .map((f) => [f, new Uint8Array(fs.readFileSync(path.join(dir, f)))]),
      );
      for (const f of [manifest.model, manifest.tokens, ...manifest.data]) {
        expect(files[f.file]).toHaveLength(f.bytes);
        expect(sha256(files[f.file]!)).toBe(f.sha256);
      }
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toEqual(manifest);

      vi.stubGlobal('fetch', fakeServer('models/m/', files, manifest).fetch);
      const loaded = await fetchCtcModel('m', () => {});
      expect(loaded.tokens).toEqual(['<blk>', '▁a']);
      const locations = new Set(readInitializers(loaded.model).map((t) => t.external.location));
      expect(loaded.externalData.every((d) => locations.has(d.path))).toBe(true);
      expect(
        verifyExternalData(
          model,
          loaded.model,
          loaded.externalData.map((d) => ({ name: d.path, bytes: d.data })),
        ),
      ).toBe(3);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
