// Test helpers: tiny ONNX-shaped protobuf files and a fake server for a model folder.
import { createHash } from 'node:crypto';

function varint(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const bytesField = (field: number, payload: Uint8Array) =>
  concat([Uint8Array.from([...varint(field * 8 + 2), ...varint(payload.length)]), payload]);
const varintField = (field: number, value: number) =>
  Uint8Array.from([...varint(field * 8), ...varint(value)]);
const text = (s: string) => new TextEncoder().encode(s);

export interface FakeTensor {
  name: string;
  dims: number[];
  raw?: Uint8Array;
  /** Values stored as float_data (field 4, packed) instead of raw_data. */
  floats?: number[];
  /** Write data_location = DEFAULT explicitly, as some exporters do. */
  explicitDefaultLocation?: boolean;
}

/** A ModelProto with an ir_version, a graph (one node, the tensors as initializers) and metadata. */
export function encodeModel({
  metadata = {},
  tensors = [],
}: {
  metadata?: Record<string, string>;
  tensors?: FakeTensor[];
}): Uint8Array {
  const node = bytesField(
    1,
    concat([bytesField(1, text('x')), bytesField(2, text('y')), bytesField(4, text('Relu'))]),
  );
  const initializers = tensors.map((t) => {
    const parts = [
      ...t.dims.map((d) => varintField(1, d)),
      varintField(2, t.raw ? 3 : 1),
      bytesField(8, text(t.name)),
    ];
    if (t.raw) parts.push(bytesField(9, t.raw));
    if (t.floats) parts.push(bytesField(4, new Uint8Array(Float32Array.from(t.floats).buffer)));
    if (t.explicitDefaultLocation) parts.push(varintField(14, 0));
    return bytesField(5, concat(parts));
  });
  const graph = concat([node, bytesField(2, text('graph')), ...initializers]);
  const meta = Object.entries(metadata).map(([k, v]) =>
    bytesField(14, concat([bytesField(1, text(k)), bytesField(2, text(v))])),
  );
  return concat([varintField(1, 7), bytesField(2, text('test')), bytesField(7, graph), ...meta]);
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = b[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

/** Top-level fields of a protobuf message (varint value or length-delimited payload). */
export function decodeFields(b: Uint8Array): { field: number; value: number; payload: Uint8Array | null }[] {
  const out: { field: number; value: number; payload: Uint8Array | null }[] = [];
  for (let pos = 0; pos < b.length;) {
    let tag: number;
    [tag, pos] = readVarint(b, pos);
    if ((tag & 7) === 0) {
      let value: number;
      [value, pos] = readVarint(b, pos);
      out.push({ field: tag >> 3, value, payload: null });
    } else if ((tag & 7) === 2) {
      let length: number;
      [length, pos] = readVarint(b, pos);
      out.push({ field: tag >> 3, value: length, payload: b.subarray(pos, pos + length) });
      pos += length;
    } else throw new Error('unexpected wire type');
  }
  return out;
}

/** The initializers of a model: name, inline raw bytes, or where their external data is. */
export function readInitializers(model: Uint8Array) {
  const graph = decodeFields(model).find((f) => f.field === 7)!.payload!;
  const utf8 = new TextDecoder();
  return decodeFields(graph)
    .filter((f) => f.field === 5)
    .map((f) => {
      const fields = decodeFields(f.payload!);
      const external: Record<string, string> = {};
      for (const e of fields.filter((x) => x.field === 13)) {
        const [k, v] = decodeFields(e.payload!).map((x) => utf8.decode(x.payload!));
        external[k!] = v!;
      }
      return {
        name: utf8.decode(fields.find((x) => x.field === 8)!.payload!),
        raw: fields.find((x) => x.field === 9)?.payload ?? null,
        location: fields.find((x) => x.field === 14)?.value ?? null,
        external,
      };
    });
}

/**
 * A `fetch` serving `files` under `http://localhost:3000/<prefix>` plus a manifest.json listing
 * them (*.onnx the graph, *.data the weight parts in order, tokens.* the token table).
 */
export function fakeServer(prefix: string, files: Record<string, Uint8Array>, manifestOverride?: unknown) {
  const describe = (file: string) => ({ file, bytes: files[file]!.length, sha256: sha256(files[file]!) });
  const names = Object.keys(files);
  const graph = names.find((n) => n.endsWith('.onnx'));
  const tokens = names.find((n) => n.startsWith('tokens.'));
  const manifest =
    manifestOverride ??
    (graph && tokens
      ? {
          format: 1,
          model: describe(graph),
          data: names.filter((n) => n.endsWith('.data')).map(describe),
          tokens: describe(tokens),
        }
      : null);
  const requests: string[] = [];
  const served: Record<string, Uint8Array> = { ...files };
  if (manifest) served['manifest.json'] = text(JSON.stringify(manifest));
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href);
    requests.push(url.pathname);
    const name = url.pathname.startsWith(`/${prefix}`) ? url.pathname.slice(prefix.length + 1) : null;
    const body = name !== null ? served[name] : undefined;
    if (!body) return new Response('not found', { status: 404 });
    // Delivered in two chunks, as a network would.
    const half = Math.ceil(body.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (body.length) controller.enqueue(body.slice(0, half));
        if (body.length > half) controller.enqueue(body.slice(half));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { fetch, requests, manifest };
}
