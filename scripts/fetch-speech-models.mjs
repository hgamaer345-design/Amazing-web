// Downloads the speech models the static demo serves from its own /models/ folder (Whisper itself
// comes from the Hugging Face hub at run time). Files are checksum-verified and kept in
// vendor/speech-models/ (not committed), so later builds don't download them again.
//   node scripts/fetch-speech-models.mjs
//
// The two CTC recognizers (SenseVoice, Omnilingual ASR) are larger than GitHub's 100 MB file limit,
// so each is served as its graph plus its weights as ONNX external data in parts of at most 45 MB,
// listed in <folder>/manifest.json. ONNX Runtime Web then copies every weight straight into its
// final place: a model in one buffer is first copied whole into the WebAssembly heap and parsed
// there, which needed twice the memory (SenseVoice 590 MB of heap after loading, 298 MB this way).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEECH_MODELS_DIR = path.join(root, 'vendor/speech-models');

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/** Output file -> where it comes from. Names match SPEAKER_MODEL_FILES in src/web/demo/speech/models.ts. */
const MODELS = [
  {
    // pyannote/segmentation-3.0 (MIT), exported to ONNX by sherpa-onnx.
    file: 'pyannote-segmentation-3.0.onnx',
    url: `${RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    member: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
    memberSha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  },
  {
    // WeSpeaker ResNet34-LM trained on VoxCeleb (CC BY 4.0), exported to ONNX by sherpa-onnx.
    file: 'wespeaker-voxceleb-resnet34-LM.onnx',
    url: `${RELEASES}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx`,
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
  },
];

/**
 * Speech-to-text models served in parts; `dir` matches SENSEVOICE_DIR / OMNILINGUAL_DIR in
 * src/web/demo/speech/. Only the model and its token table are taken from each release.
 */
const CTC_MODELS = [
  {
    dir: 'sensevoice-small-int8',
    url: `${RELEASES}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
    sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',
    model: {
      member: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx',
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    },
    tokens: {
      member: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/tokens.txt',
      sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    },
  },
  {
    dir: 'omnilingual-300m-ctc-int8',
    url: `${RELEASES}/asr-models/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12.tar.bz2`,
    sha256: 'cdcd0559c7c73efed54209a926e321afc914d046c5fdbf3665f00dc78180e5ed',
    model: {
      member: 'sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/model.int8.onnx',
      sha256: 'e7c4e54ee4c4c47829cc6667d5d00ed8ea7bef1dcfeef0fce766f77752a2726c',
    },
    tokens: {
      member: 'sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/tokens.txt',
      sha256: 'a7a044c52cb29cbe8b0dc1953e92cefd4ca16b0ed968177b6beab21f9a7d0b31',
    },
  },
];

/** Largest served file (GitHub refuses files over 100 MB and warns from 50 MB). */
export const MAX_PART_BYTES = 45_000_000;

/** Bump when the layout of the served files changes, so vendor/ copies are rebuilt. */
const MANIFEST_FORMAT = 1;

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.`;

const ATTRIBUTION = `Speech models used by the in-browser demo

pyannote-segmentation-3.0.onnx
  pyannote/segmentation-3.0 (https://huggingface.co/pyannote/segmentation-3.0),
  converted to ONNX by sherpa-onnx (https://github.com/k2-fsa/sherpa-onnx, Apache-2.0).

  MIT License

  Copyright (c) 2022 CNRS

  ${MIT_TERMS}

wespeaker-voxceleb-resnet34-LM.onnx
  WeSpeaker ResNet34-LM speaker embedding model trained on VoxCeleb, by the WeSpeaker project
  (https://github.com/wenet-e2e/wespeaker), licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). Converted to ONNX by sherpa-onnx (Apache-2.0).

sensevoice-small-int8/
  SenseVoiceSmall (model name: SenseVoiceSmall, "iic/SenseVoiceSmall"), by Tongyi Lab, Alibaba
  Group (FunAudioLLM, https://github.com/FunAudioLLM/SenseVoice,
  https://huggingface.co/FunAudioLLM/SenseVoiceSmall). Used under the FunASR Model Open Source
  License Agreement v1.1 (https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE), which
  permits using, copying, modifying and sharing the model provided its source, authors and model
  name are attributed, as they are here; see the agreement for its full terms (Copyright
  2023-2028 Alibaba Group). Quantized to int8 and exported to ONNX by sherpa-onnx
  (sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17, Apache-2.0); stored here as ONNX
  external data in parts, unchanged otherwise.

omnilingual-300m-ctc-int8/
  Omnilingual ASR 300M CTC (omniASR_CTC_300M) by Meta Platforms, Inc. and affiliates
  (https://github.com/facebookresearch/omnilingual-asr). Copyright 2025 (c) Meta Platforms, Inc.
  and affiliates. Licensed under the Apache License, Version 2.0 (see LICENSE-Apache-2.0.txt, or
  http://www.apache.org/licenses/LICENSE-2.0). Quantized to int8 and exported to ONNX by
  sherpa-onnx (sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12, Apache-2.0);
  stored here as ONNX external data in parts, unchanged otherwise.
`;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

function download(url, dest) {
  return run('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '-o', dest, url]);
}

/** A parallel bzip2 when the machine has one (decompressing is most of the time otherwise). */
function bzip2Program() {
  for (const p of ['lbzip2', 'pbzip2'])
    if (spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0) return p;
  return null;
}

async function extract(archive, dir, members) {
  const program = bzip2Program();
  await run('tar', [...(program ? ['-I', program, '-xf'] : ['-xjf']), archive, '-C', dir, ...members]);
}

// ---- ONNX external data, without a protobuf library ----
// ModelProto.graph = 7; GraphProto.initializer = 5; TensorProto.raw_data = 9, external_data = 13
// (StringStringEntryProto: key 1, value 2), data_location = 14 (1 = EXTERNAL).

function readVarint(b, pos) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    if (pos >= b.length) throw new Error('truncated varint');
    byte = b[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

function varint(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

/** Top-level fields of a protobuf message: number, wire type, byte range, payload range. */
function fields(b) {
  const out = [];
  for (let pos = 0; pos < b.length;) {
    const start = pos;
    let tag;
    [tag, pos] = readVarint(b, pos);
    const wire = tag & 7;
    let payload = pos;
    if (wire === 0) [, pos] = readVarint(b, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let length;
      [length, payload] = readVarint(b, pos);
      pos = payload + length;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (pos > b.length) throw new Error('truncated protobuf field');
    out.push({ field: Math.floor(tag / 8), wire, start, end: pos, payload });
  }
  return out;
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function bytesField(field, payload) {
  return concat([Uint8Array.from([...varint(field * 8 + 2), ...varint(payload.length)]), payload]);
}

const utf8 = (s) => new TextEncoder().encode(s);

function entry(key, value) {
  return bytesField(13, concat([bytesField(1, utf8(key)), bytesField(2, utf8(value))]));
}

/** Tensors smaller than this stay inline (scales, zero points, shapes). */
const MIN_EXTERNAL_BYTES = 1024;

/**
 * Moves the weights (initializers stored as raw_data) of an ONNX model into external data files of
 * at most `maxPartBytes`, in graph order. `partName(bytes)` names each part (the graph refers to
 * them by name). Returns the new graph file and the parts.
 */
export function toExternalData(model, maxPartBytes, partName) {
  const top = fields(model);
  const graphField = top.find((f) => f.field === 7 && f.wire === 2);
  if (!graphField) throw new Error('not an ONNX model (no graph)');
  const graph = model.subarray(graphField.payload, graphField.end);
  const graphFields = fields(graph);
  const parts = [];
  const plan = graphFields.map((f) => {
    if (f.field !== 5 || f.wire !== 2) return null;
    const tensor = graph.subarray(f.payload, f.end);
    const tensorFields = fields(tensor);
    const raw = tensorFields.find((t) => t.field === 9 && t.wire === 2);
    // Already external (external_data entries, or data_location = EXTERNAL).
    const external = tensorFields.some(
      (t) => t.field === 13 || (t.field === 14 && t.wire === 0 && readVarint(tensor, t.payload)[0] !== 0),
    );
    if (!raw || external) return null;
    const data = tensor.subarray(raw.payload, raw.end);
    if (data.length < MIN_EXTERNAL_BYTES) return null;
    if (data.length > maxPartBytes) throw new Error(`a tensor of ${data.length} bytes exceeds the part size`);
    let part = parts.at(-1);
    // 64-byte aligned offsets, as onnx.save_model writes them.
    const aligned = (n) => Math.ceil(n / 64) * 64;
    if (!part || aligned(part.size) + data.length > maxPartBytes) {
      part = { size: 0, chunks: [] };
      parts.push(part);
    }
    const offset = aligned(part.size);
    part.chunks.push({ offset, data });
    part.size = offset + data.length;
    return { part: parts.length - 1, offset, length: data.length, tensor, tensorFields };
  });
  const partBytes = parts.map((p) => {
    const bytes = new Uint8Array(p.size);
    for (const c of p.chunks) bytes.set(c.data, c.offset);
    return bytes;
  });
  const names = partBytes.map((bytes) => partName(bytes));
  const newGraph = concat(
    graphFields.map((f, i) => {
      const p = plan[i];
      if (!p) return graph.subarray(f.start, f.end);
      const kept = p.tensorFields
        .filter((t) => t.field !== 9 && t.field !== 14)
        .map((t) => p.tensor.subarray(t.start, t.end));
      return bytesField(
        5,
        concat([
          ...kept,
          entry('location', names[p.part]),
          entry('offset', String(p.offset)),
          entry('length', String(p.length)),
          Uint8Array.from([...varint(14 * 8), 1]),
        ]),
      );
    }),
  );
  const out = concat(
    top.map((f) => (f === graphField ? bytesField(7, newGraph) : model.subarray(f.start, f.end))),
  );
  return { graph: out, parts: names.map((name, i) => ({ name, bytes: partBytes[i] })) };
}

const equalBytes = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);

/**
 * Checks that `graph` + `parts` hold exactly the tensors of `original`: same fields in the same
 * order, every moved tensor's bytes identical. Throws otherwise.
 */
export function verifyExternalData(original, graph, parts) {
  const byName = new Map(parts.map((p) => [p.name, p.bytes]));
  const graphOf = (m) => {
    const g = fields(m).find((f) => f.field === 7 && f.wire === 2);
    return m.subarray(g.payload, g.end);
  };
  const a = graphOf(original);
  const b = graphOf(graph);
  const fa = fields(a);
  const fb = fields(b);
  if (fa.length !== fb.length) throw new Error('graph field count changed');
  const decoder = new TextDecoder();
  let moved = 0;
  fa.forEach((f, i) => {
    const g = fb[i];
    if (equalBytes(a.subarray(f.start, f.end), b.subarray(g.start, g.end))) return;
    if (f.field !== 5 || g.field !== 5) throw new Error(`graph field ${i} changed`);
    const raw = fields(a.subarray(f.payload, f.end)).find((t) => t.field === 9);
    const info = {};
    const tensor = b.subarray(g.payload, g.end);
    for (const t of fields(tensor)) {
      if (t.field !== 13) continue;
      const kv = tensor.subarray(t.payload, t.end);
      const [k, v] = fields(kv).map((x) => decoder.decode(kv.subarray(x.payload, x.end)));
      info[k] = v;
    }
    const data = byName
      .get(info.location)
      ?.subarray(Number(info.offset), Number(info.offset) + Number(info.length));
    const expected = a.subarray(f.payload, f.end).subarray(raw.payload, raw.end);
    if (!data || !equalBytes(data, expected))
      throw new Error(`tensor ${i} differs after moving it to external data`);
    moved++;
  });
  return moved;
}

// ---- served files ----

function hashedName(prefix, ext, bytes) {
  return `${prefix}.${sha256(bytes).slice(0, 16)}${ext}`;
}

function described(file, bytes) {
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
}

/** Whether `dir` already holds the files built from this source, intact. */
function isBuilt(dir, model) {
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return false;
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (m.format !== MANIFEST_FORMAT || m.source?.sha256 !== model.model.sha256) return false;
    return [m.model, m.tokens, ...m.data].every((f) => {
      const p = path.join(dir, f.file);
      return fs.existsSync(p) && fs.statSync(p).size === f.bytes && sha256File(p) === f.sha256;
    });
  } catch {
    return false;
  }
}

/** Writes the served files of one model (graph, weight parts, tokens, manifest) into `dir`. */
export function writeServedModel(dir, modelBytes, tokenBytes, source) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { graph, parts } = toExternalData(modelBytes, MAX_PART_BYTES, (bytes) =>
    hashedName('model', '.data', bytes),
  );
  verifyExternalData(modelBytes, graph, parts);
  const graphName = hashedName('model', '.onnx', graph);
  const tokensName = hashedName('tokens', '.txt', tokenBytes);
  fs.writeFileSync(path.join(dir, graphName), graph);
  for (const p of parts) fs.writeFileSync(path.join(dir, p.name), p.bytes);
  fs.writeFileSync(path.join(dir, tokensName), tokenBytes);
  const manifest = {
    format: MANIFEST_FORMAT,
    source,
    model: described(graphName, graph),
    data: parts.map((p) => described(p.name, p.bytes)),
    tokens: described(tokensName, tokenBytes),
  };
  // Written last: a folder without a manifest is rebuilt next time.
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

async function fetchCtcModel(model) {
  const dir = path.join(SPEECH_MODELS_DIR, model.dir);
  if (isBuilt(dir, model)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-'));
  try {
    const archive = path.join(tmp, path.basename(new URL(model.url).pathname));
    console.log(`Downloading ${model.url}`);
    await download(model.url, archive);
    if (sha256File(archive) !== model.sha256) throw new Error(`Checksum mismatch for ${model.url}`);
    await extract(archive, tmp, [model.model.member, model.tokens.member]);
    fs.rmSync(archive);
    const modelBytes = new Uint8Array(fs.readFileSync(path.join(tmp, model.model.member)));
    const tokenBytes = new Uint8Array(fs.readFileSync(path.join(tmp, model.tokens.member)));
    if (sha256(modelBytes) !== model.model.sha256)
      throw new Error(`Checksum mismatch for ${model.model.member}`);
    if (sha256(tokenBytes) !== model.tokens.sha256)
      throw new Error(`Checksum mismatch for ${model.tokens.member}`);
    const { data } = writeServedModel(dir, modelBytes, tokenBytes, {
      url: model.url,
      member: model.model.member,
      sha256: model.model.sha256,
    });
    console.log(`${model.dir}: graph + ${data.length} weight parts`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchSpeakerModel(model) {
  const dest = path.join(SPEECH_MODELS_DIR, model.file);
  const expected = model.memberSha256 ?? model.sha256;
  if (fs.existsSync(dest) && sha256File(dest) === expected) return;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-'));
  try {
    const downloaded = path.join(tmp, path.basename(new URL(model.url).pathname));
    console.log(`Downloading ${model.url}`);
    await download(model.url, downloaded);
    if (sha256File(downloaded) !== model.sha256) throw new Error(`Checksum mismatch for ${model.url}`);
    let source = downloaded;
    if (model.member) {
      await extract(downloaded, tmp, [model.member]);
      source = path.join(tmp, model.member);
      if (sha256File(source) !== model.memberSha256) throw new Error(`Checksum mismatch for ${model.member}`);
    }
    fs.copyFileSync(source, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Makes sure every model is in vendor/speech-models/ with the expected contents; returns the directory. */
export async function fetchSpeechModels() {
  fs.mkdirSync(SPEECH_MODELS_DIR, { recursive: true });
  // In parallel: the downloads and the (single-threaded) bzip2 decompression are most of the time.
  await Promise.all([...MODELS.map(fetchSpeakerModel), ...CTC_MODELS.map(fetchCtcModel)]);
  fs.writeFileSync(path.join(SPEECH_MODELS_DIR, 'ATTRIBUTION.txt'), ATTRIBUTION);
  const apache = path.join(root, 'node_modules/@huggingface/transformers/LICENSE');
  if (fs.existsSync(apache)) fs.copyFileSync(apache, path.join(SPEECH_MODELS_DIR, 'LICENSE-Apache-2.0.txt'));
  return SPEECH_MODELS_DIR;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchSpeechModels();
  console.log(`Speech models ready in ${path.relative(root, SPEECH_MODELS_DIR)}`);
}
