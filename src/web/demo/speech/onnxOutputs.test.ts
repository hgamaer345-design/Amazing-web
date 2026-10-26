import { stripOutputs, UNUSED_WHISPER_OUTPUT } from './onnxOutputs';

// Minimal protobuf writer for test models.
const varint = (v: number): number[] => {
  const out: number[] = [];
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
};
const bytesField = (field: number, payload: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(payload.length),
  ...payload,
];
const varintField = (field: number, v: number) => [...varint(field * 8), ...varint(v)];
const str = (s: string) => [...new TextEncoder().encode(s)];
const valueInfo = (name: string) => [...bytesField(1, str(name)), ...bytesField(2, [8, 1])];

function model(outputs: string[], padding = 0): Uint8Array {
  const graph = [
    ...bytesField(1, bytesField(4, str('MatMul'))), // a node
    ...bytesField(2, str('main_graph')),
    ...bytesField(11, valueInfo('input_features')),
    ...outputs.flatMap((o) => bytesField(12, valueInfo(o))),
    ...bytesField(5, new Array<number>(padding).fill(7)), // an initializer
  ];
  return Uint8Array.from([
    ...varintField(1, 8),
    ...bytesField(7, graph),
    ...bytesField(8, varintField(2, 17)),
  ]);
}

describe('stripOutputs', () => {
  it('removes only the selected graph outputs and keeps everything else byte for byte', () => {
    const original = model(['last_hidden_state', 'encoder_attentions.0', 'encoder_attentions.1']);
    const stripped = stripOutputs(original, (n) => UNUSED_WHISPER_OUTPUT.test(n));
    expect(stripped).toEqual(model(['last_hidden_state']));
  });

  it('rewrites the graph length when it needs a different number of length bytes', () => {
    // A graph of a little over 128 bytes shrinks below it: its length prefix loses a byte.
    const original = model(['logits', 'cross_attentions.0', 'decoder_attentions.0'], 60);
    const stripped = stripOutputs(original, (n) => UNUSED_WHISPER_OUTPUT.test(n));
    expect(stripped).toEqual(model(['logits'], 60));
  });

  it('returns the same bytes when nothing matches or there is no graph', () => {
    const original = model(['logits', 'present.0.decoder.key']);
    expect(stripOutputs(original, (n) => UNUSED_WHISPER_OUTPUT.test(n))).toBe(original);
    const noGraph = Uint8Array.from(varintField(1, 8));
    expect(stripOutputs(noGraph, () => true)).toBe(noGraph);
  });

  it('rejects truncated files instead of producing a broken model', () => {
    const original = model(['encoder_attentions.0']);
    expect(() => stripOutputs(original.subarray(0, original.length - 3), () => true)).toThrow();
  });
});
