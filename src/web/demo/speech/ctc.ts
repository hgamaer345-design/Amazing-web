// Shared by the CTC recognizers (SenseVoice, Omnilingual ASR), both sherpa-onnx exports: their
// token tables, greedy CTC decoding, the settings sherpa-onnx keeps in the ONNX file, and loading
// a model served in parts.
import type * as ort from 'onnxruntime-web/webgpu';
import { fetchFiles, fetchManifest, modelUrl, pruneCache, type ByteProgress } from './download';

/** The part of an ONNX Runtime session the recognizers use (so they can also be measured in Node). */
export interface OnnxSession {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
  release(): Promise<void>;
}

/** Session options of the CTC models (see docs/ARCHITECTURE.md for the memory measurements). */
export const CTC_SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: ['wasm'],
  enableCpuMemArena: false,
  enableMemPattern: false,
};

/**
 * Symbols by id from sherpa-onnx's tokens.txt: "<symbol> <id>" per line, where a line holding only
 * an id is the space symbol (Omnilingual ASR's word boundary).
 */
export function parseTokens(text: string): string[] {
  const symbols: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const at = line.lastIndexOf(' ');
    const id = Number(line.slice(at + 1));
    if (!Number.isInteger(id) || id < 0) throw new Error(`Bad token line: ${JSON.stringify(line)}`);
    const symbol = line.slice(0, Math.max(0, at));
    symbols[id] = symbol.trim() ? symbol : ' ';
  }
  return symbols;
}

/** Index of the highest score in `logits[row, row + vocab)`, among `allowed` classes if given. */
function argmax(logits: Float32Array, row: number, vocab: number, allowed?: Uint8Array, skip = -1): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < vocab; v++) {
    const score = logits[row + v]!;
    if (score > bestScore && v !== skip && (!allowed || allowed[v])) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/** `allowed` values: not allowed, allowed, allowed and used in place of classes that aren't. */
export const NOT_ALLOWED = 0;
export const ALLOWED = 1;
export const REPLACEMENT = 2;

/**
 * Greedy CTC decoding of `logits` (frames × vocab, row-major): the best class of every frame,
 * repeats merged, blanks dropped. Returns the token ids. With `allowed`, a frame whose best class
 * isn't allowed takes the best REPLACEMENT class instead (never the blank: CTC scores are so peaked
 * that the blank comes second almost everywhere, which would leave no text).
 */
export function ctcGreedy(
  logits: Float32Array,
  frames: number,
  vocab: number,
  blank = 0,
  allowed?: Uint8Array,
): number[] {
  const replacements = allowed?.map((a) => (a === REPLACEMENT ? 1 : 0));
  const ids: number[] = [];
  let previous = -1;
  for (let t = 0; t < frames; t++) {
    let best = argmax(logits, t * vocab, vocab);
    if (allowed && best !== blank && !allowed[best])
      best = argmax(logits, t * vocab, vocab, replacements, blank);
    if (best !== blank && best >= 0 && best !== previous) ids.push(best);
    previous = best;
  }
  return ids;
}

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    if (pos >= b.length) throw new Error('truncated varint');
    byte = b[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

/** Calls `visit` for each field of a protobuf message (length-delimited ones with their payload). */
function eachField(b: Uint8Array, visit: (field: number, payload: Uint8Array | null) => void): void {
  for (let pos = 0; pos < b.length;) {
    let tag: number;
    [tag, pos] = readVarint(b, pos);
    const wire = tag & 7;
    let payload: Uint8Array | null = null;
    if (wire === 0) [, pos] = readVarint(b, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let length: number;
      [length, pos] = readVarint(b, pos);
      payload = b.subarray(pos, pos + length);
      pos += length;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (pos > b.length) throw new Error('truncated protobuf field');
    visit(Math.floor(tag / 8), payload);
  }
}

/**
 * The key-value metadata of an ONNX model file (ModelProto.metadata_props, field 14: key 1, value
 * 2), where sherpa-onnx keeps the settings its runtime needs. Skips over the graph without parsing it.
 */
export function onnxMetadata(model: Uint8Array): Record<string, string> {
  const utf8 = new TextDecoder();
  const out: Record<string, string> = {};
  eachField(model, (field, payload) => {
    if (field !== 14 || !payload) return;
    let key = '';
    let value = '';
    eachField(payload, (f, p) => {
      if (f === 1 && p) key = utf8.decode(p);
      else if (f === 2 && p) value = utf8.decode(p);
    });
    out[key] = value;
  });
  return out;
}

/** A model as ONNX Runtime takes it: the graph, and its weights as external data files. */
export interface CtcModelFiles {
  model: Uint8Array;
  externalData: { path: string; data: Uint8Array }[];
  tokens: string[];
}

/** A model and its token table from `models/<dir>/` (see scripts/fetch-speech-models.mjs). */
export async function fetchCtcModel(dir: string, onProgress: ByteProgress): Promise<CtcModelFiles> {
  const manifest = await fetchManifest(dir);
  const base = modelUrl(`${dir}/`);
  const files = [manifest.tokens, manifest.model, ...manifest.data];
  const [tokens, model, ...data] = await fetchFiles(base, files, onProgress);
  // Files of an earlier version of the model would otherwise stay in the cache for good.
  await pruneCache(base, ['manifest.json', ...files.map((f) => f.file)]);
  return {
    model: model!,
    externalData: manifest.data.map((f, i) => ({ path: f.file, data: data[i]! })),
    tokens: parseTokens(new TextDecoder().decode(tokens)),
  };
}
