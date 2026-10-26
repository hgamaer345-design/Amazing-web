// Removes declared outputs from an ONNX model file before ONNX Runtime loads it, without a
// protobuf library. The Whisper conversions on the hub also output every layer's attention
// weights (for Whisper Tiny about 200 MB per 30 s pass, Base 400 MB, Small 1.2 GB). ONNX Runtime
// builds them in its WebAssembly heap, which never shrinks, and copies them into JavaScript,
// although transcription never reads them. Undeclared, they are never materialised; the
// transcript is unchanged.
//
// Wire format: ModelProto.graph is field 7, GraphProto.output field 12, ValueInfoProto.name field 1.

/** Graph outputs of the Whisper models that transcription doesn't use. */
export const UNUSED_WHISPER_OUTPUT = /^(encoder_attentions|decoder_attentions|cross_attentions)\./;

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

interface Field {
  field: number;
  wire: number;
  /** Byte range of the whole field (tag included) and of its payload. */
  start: number;
  end: number;
  payload: number;
}

/** Top-level fields of a protobuf message. */
function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  for (let pos = 0; pos < b.length;) {
    const start = pos;
    let tag: number;
    [tag, pos] = readVarint(b, pos);
    const wire = tag & 7;
    let payload = pos;
    if (wire === 0) [, pos] = readVarint(b, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let length: number;
      [length, payload] = readVarint(b, pos);
      pos = payload + length;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (pos > b.length) throw new Error('truncated protobuf field');
    out.push({ field: Math.floor(tag / 8), wire, start, end: pos, payload });
  }
  return out;
}

const utf8 = new TextDecoder();

function valueInfoName(b: Uint8Array): string {
  for (const f of fields(b))
    if (f.field === 1 && f.wire === 2) return utf8.decode(b.subarray(f.payload, f.end));
  return '';
}

/** The model without the graph outputs `drop` selects (the same bytes if none match). */
export function stripOutputs(model: Uint8Array, drop: (name: string) => boolean): Uint8Array {
  const top = fields(model);
  const graphField = top.find((f) => f.field === 7 && f.wire === 2);
  if (!graphField) return model;
  const graph = model.subarray(graphField.payload, graphField.end);
  const graphFields = fields(graph);
  const kept = graphFields.filter(
    (f) => !(f.field === 12 && f.wire === 2 && drop(valueInfoName(graph.subarray(f.payload, f.end)))),
  );
  if (kept.length === graphFields.length) return model;
  const graphLength = kept.reduce((n, f) => n + f.end - f.start, 0);
  const header = [...varint(7 * 8 + 2), ...varint(graphLength)];
  const total = top.reduce(
    (n, f) => n + (f === graphField ? header.length + graphLength : f.end - f.start),
    0,
  );
  const out = new Uint8Array(total);
  let pos = 0;
  for (const f of top) {
    if (f === graphField) {
      out.set(header, pos);
      pos += header.length;
      for (const k of kept) {
        out.set(graph.subarray(k.start, k.end), pos);
        pos += k.end - k.start;
      }
    } else {
      out.set(model.subarray(f.start, f.end), pos);
      pos += f.end - f.start;
    }
  }
  return out;
}
