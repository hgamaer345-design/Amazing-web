// Model loading for the speech worker: ONNX Runtime set-up, the two speaker models (served from
// this site) and Whisper (downloaded from the Hugging Face hub by transformers.js). Everything
// is cached by the browser after the first run.
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { QualityMode } from '../../../shared/types';
import type { DiarizationModels } from './diarize';
import { computeFbank, subtractMean } from './fbank';
import { stripOutputs, UNUSED_WHISPER_OUTPUT } from './onnxOutputs';
import { cleanTranscript, hasLoop, transcribeChecked, type ClipDecode } from './text';
import { splitLongTurns } from './turns';

/** Whisper model per quality mode (multilingual; 8-bit quantized for WebAssembly). */
export const WHISPER_MODELS: Record<QualityMode, { id: string; label: string; approxMB: number }> = {
  standard: { id: 'Xenova/whisper-tiny', label: 'Whisper Tiny', approxMB: 41 },
  high: { id: 'Xenova/whisper-base', label: 'Whisper Base', approxMB: 77 },
  ultra: { id: 'Xenova/whisper-small', label: 'Whisper Small', approxMB: 249 },
};

/** Speaker models shipped with the site (see scripts/fetch-speech-models.mjs). */
export const SPEAKER_MODEL_FILES = {
  segmentation: 'pyannote-segmentation-3.0.onnx',
  embedding: 'wespeaker-voxceleb-resnet34-LM.onnx',
} as const;

/**
 * Speaker-analysis settings: hop between the 10 s analysis windows, spacing of the windows that
 * get their own voice fingerprint (the others are matched to them), least clean speech per
 * fingerprint and the most speech used for one. The same for every quality mode. Fingerprints use
 * all of a speaker's clean speech in the window: on real recordings, ones cut to 2 s varied so
 * much that one person was split into several speakers (see docs/ARCHITECTURE.md).
 */
export const DIARIZATION_SETTINGS = {
  windowShiftSec: 2,
  embedStrideSec: 5,
  minEmbedSpeechSec: 1,
  embedSeconds: 10,
} as const;

const CACHE_NAME = 'speaker-transcriber-models-v1';
let configured = false;
let lite = false;

/**
 * Points ONNX Runtime at the WebAssembly files bundled with the site and picks a thread count.
 * The first call decides; `liteDevice` (a phone) runs single-threaded, which iOS handles far better.
 */
export function configureRuntime(liteDevice = false): void {
  if (configured) return;
  configured = true;
  lite = liteDevice;
  const wasmPaths = {
    mjs: new URL(ortMjsUrl, self.location.href).href,
    wasm: new URL(ortWasmUrl, self.location.href).href,
  };
  ort.env.wasm.wasmPaths = wasmPaths;
  // Threads need cross-origin isolation (provided by the coi-serviceworker on GitHub Pages).
  ort.env.wasm.numThreads =
    self.crossOriginIsolated && !lite ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
  // transformers.js shares this ONNX Runtime instance (and so these settings); Whisper comes from
  // the hub, never from this site's own /models/ folder.
  env.allowLocalModels = false;
  // ONNX Runtime is already set up from the files above; don't let transformers.js fetch and keep
  // a second copy of the WebAssembly binary.
  env.useWasmCache = false;
  // Whisper's unused attention outputs would take hundreds of MB per pass (see onnxOutputs.ts).
  // transformers.js looks `create` up on every call, so this covers its sessions too.
  const create = ort.InferenceSession.create.bind(ort.InferenceSession);
  ort.InferenceSession.create = ((model: unknown, ...rest: unknown[]) =>
    (create as (...args: unknown[]) => Promise<ort.InferenceSession>)(
      model instanceof Uint8Array ? withoutUnusedOutputs(model) : model,
      ...rest,
    )) as typeof ort.InferenceSession.create;
}

function withoutUnusedOutputs(model: Uint8Array): Uint8Array {
  try {
    return stripOutputs(model, (name) => UNUSED_WHISPER_OUTPUT.test(name));
  } catch {
    return model; // not a file this parser understands: let ONNX Runtime load it as it is
  }
}

/** A model that couldn't be downloaded ("download") or couldn't be started, e.g. out of memory ("load"). */
export class ModelLoadError extends Error {
  constructor(
    readonly kind: 'download' | 'load',
    message: string,
  ) {
    super(message);
    this.name = 'ModelLoadError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** transformers.js reports failed downloads as fetch TypeErrors or HTTP/"locate file" errors. */
function isDownloadError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    /fetch|network|download|could not locate|status|unauthorized|forbidden|not found|\b40\d\b|\b50\d\b/i.test(
      errorMessage(err),
    )
  );
}

/** On phones, return freed memory instead of keeping ONNX Runtime's arena and buffer plans. */
function liteSessionOptions(): ort.InferenceSession.SessionOptions {
  return lite ? { enableCpuMemArena: false, enableMemPattern: false } : {};
}

export type ByteProgress = (loaded: number, total: number) => void;

/** Fetches a file with byte progress, keeping a copy in the Cache API for next time. */
async function fetchCached(url: string, onProgress: ByteProgress): Promise<Uint8Array> {
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

function modelUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}models/${file}`, self.location.href).href;
}

let speakerSessions: Promise<{ segmentation: ort.InferenceSession; embedding: ort.InferenceSession }> | null =
  null;

/** Loads (once) the segmentation and embedding models. */
export function loadSpeakerModels(onProgress: ByteProgress) {
  speakerSessions ??= (async () => {
    configureRuntime();
    const progress = { seg: [0, 6_000_000], emb: [0, 26_500_000] };
    const report = () => onProgress(progress.seg[0]! + progress.emb[0]!, progress.seg[1]! + progress.emb[1]!);
    const [segBytes, embBytes] = await Promise.all([
      fetchCached(modelUrl(SPEAKER_MODEL_FILES.segmentation), (l, t) => {
        progress.seg = [l, t];
        report();
      }),
      fetchCached(modelUrl(SPEAKER_MODEL_FILES.embedding), (l, t) => {
        progress.emb = [l, t];
        report();
      }),
    ]).catch((err: unknown) => {
      throw new ModelLoadError('download', errorMessage(err));
    });
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      ...liteSessionOptions(),
    };
    try {
      return {
        segmentation: await ort.InferenceSession.create(segBytes, options),
        embedding: await ort.InferenceSession.create(embBytes, options),
      };
    } catch (err) {
      throw new ModelLoadError('load', errorMessage(err));
    }
  })().catch((err: unknown) => {
    speakerSessions = null;
    throw err;
  });
  return speakerSessions;
}

/** The diarization callbacks backed by the ONNX models. */
export function speakerModelRunners(
  sessions: { segmentation: ort.InferenceSession; embedding: ort.InferenceSession },
  embedSeconds: number,
): DiarizationModels {
  return {
    async segment(windows) {
      const size = windows[0]?.length ?? 0;
      const data = new Float32Array(windows.length * size);
      windows.forEach((w, i) => data.set(w, i * size));
      const input = sessions.segmentation.inputNames[0]!;
      const output = sessions.segmentation.outputNames[0]!;
      const out = await sessions.segmentation.run({
        [input]: new ort.Tensor('float32', data, [windows.length, 1, size]),
      });
      const y = out[output]!;
      const per = (y.dims[1] ?? 0) * (y.dims[2] ?? 0);
      const values = y.data as Float32Array;
      return windows.map((_, i) => values.slice(i * per, (i + 1) * per));
    },
    async embed(samples) {
      const limited =
        samples.length > embedSeconds * 16000 ? samples.subarray(0, embedSeconds * 16000) : samples;
      // Mean-normalised per segment, as WeSpeaker does before its model.
      const feats = subtractMean(computeFbank(limited));
      const frames = feats.length / 80;
      const input = sessions.embedding.inputNames[0]!;
      const output = sessions.embedding.outputNames[0]!;
      const out = await sessions.embedding.run({
        [input]: new ort.Tensor('float32', feats, [1, frames, 80]),
      });
      return Float32Array.from(out[output]!.data as Float32Array);
    },
  };
}

let whisper: { mode: QualityMode; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

/** Loads (once per mode) the Whisper pipeline, reporting download progress. */
export function loadWhisper(
  mode: QualityMode,
  onProgress: ByteProgress,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (whisper?.mode === mode) return whisper.asr;
  const previous = whisper;
  configureRuntime();
  const asr = (async () => {
    // Free the previous model's memory before loading another size.
    if (previous) await (await previous.asr.catch(() => null))?.dispose();
    try {
      return (await pipeline('automatic-speech-recognition', WHISPER_MODELS[mode].id, {
        dtype: 'q8',
        device: 'wasm',
        session_options: liteSessionOptions(),
        progress_callback: (info) => {
          if (info.status === 'progress_total') onProgress(info.loaded, info.total);
        },
      })) as AutomaticSpeechRecognitionPipeline;
    } catch (err) {
      throw new ModelLoadError(isDownloadError(err) ? 'download' : 'load', errorMessage(err));
    }
  })();
  whisper = { mode, asr };
  asr.catch(() => {
    if (whisper?.asr === asr) whisper = null;
  });
  return asr;
}

/**
 * Detects the spoken language: one decoder step after <|startoftranscript|>, choosing the most
 * likely language token. (transformers.js otherwise assumes English for multilingual models.)
 */
export async function detectLanguage(
  asr: AutomaticSpeechRecognitionPipeline,
  sample: Float32Array,
): Promise<string> {
  const { input_features } = (await asr.processor(sample)) as { input_features: Tensor };
  const config = asr.model.generation_config as unknown as {
    decoder_start_token_id: number;
    lang_to_id?: Record<string, number>;
  };
  if (!config.lang_to_id) return 'en';
  const model = asr.model as unknown as (inputs: Record<string, Tensor>) => Promise<{ logits: Tensor }>;
  const { logits } = await model({
    input_features,
    decoder_input_ids: new Tensor(
      'int64',
      BigInt64Array.from([BigInt(config.decoder_start_token_id)]),
      [1, 1],
    ),
  });
  const vocab = logits.dims[logits.dims.length - 1]!;
  const data = logits.data as Float32Array;
  const base = data.length - vocab;
  let best = { code: 'en', score: Number.NEGATIVE_INFINITY };
  for (const [token, id] of Object.entries(config.lang_to_id)) {
    const score = data[base + id]!;
    if (score > best.score) best = { code: token.slice(2, -2), score };
  }
  return best.code;
}

/** Natural-log softmax of `scores` (one vocabulary-sized row) at `index`. */
function logSoftmaxAt(scores: Float32Array, index: number): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scores.length; i++) if (scores[i]! > max) max = scores[i]!;
  let sum = 0;
  for (let i = 0; i < scores.length; i++) sum += Math.exp(scores[i]! - max);
  return scores[index]! - max - Math.log(sum);
}

/**
 * Most tokens Whisper may write for a clip: about three times the fastest speech we measured (and
 * room for scripts that take several tokens per character), so a repetition loop stops early
 * instead of running to Whisper's 448-token limit (on Tiny, ~20 s for one 13 s clip).
 */
export function maxClipTokens(seconds: number): number {
  return Math.min(440, 20 + Math.ceil(16 * seconds));
}

type WhisperModel = {
  generation_config: { eos_token_id: number; no_timestamps_token_id: number };
  forward(inputs: unknown): Promise<{ logits: Tensor }>;
};

/**
 * One greedy Whisper pass over a clip that also records, at no extra model cost, the
 * log-probability of every token Whisper chose and its no-speech probability.
 */
async function decodeScored(
  asr: AutomaticSpeechRecognitionPipeline,
  clip: Float32Array,
  language: string,
  timestamps: boolean,
): Promise<ClipDecode> {
  const model = asr.model as unknown as WhisperModel;
  const { eos_token_id: endId, no_timestamps_token_id: noTimestampsId } = model.generation_config;
  const chosen: { id: number; logprob: number }[] = [];
  // The scores are read one step late: Transformers.js runs its timestamp rules after this
  // processor and they edit the scores in place, so they are final (and the chosen token, the
  // last input id, known) only at the next step.
  let pending: Float32Array | null = null;
  const settle = (id: number) => {
    if (pending) chosen.push({ id, logprob: logSoftmaxAt(pending, id) });
    pending = null;
  };
  // A loop is ended as soon as it shows (by making <|endoftext|> the only choice) rather than
  // left to run to the token limit; Transformers.js ignores custom stopping criteria for Whisper.
  let looping = false;
  const observe = (inputIds: bigint[][], logits: Tensor) => {
    const ids = inputIds[0]!;
    settle(Number(ids.at(-1)));
    const scores = logits.data as Float32Array;
    if (!looping && hasLoop(ids.map(Number).filter((id) => id < endId))) {
      looping = true;
      scores.fill(Number.NEGATIVE_INFINITY);
      scores[endId] = 0;
    } else if (!looping) {
      pending = scores;
    }
    return logits;
  };
  // The first decoder pass scores the whole prompt; its scores right after <|startoftranscript|>
  // give the no-speech probability (as in openai/whisper) without another encoder pass.
  let noSpeechProb = Number.NaN;
  const forward = model.forward;
  model.forward = async (inputs) => {
    const out = await forward.call(model, inputs);
    if (Number.isNaN(noSpeechProb)) {
      const vocab = out.logits.dims[out.logits.dims.length - 1]!;
      const row = (out.logits.data as Float32Array).subarray(0, vocab);
      noSpeechProb = Math.exp(logSoftmaxAt(row, noTimestampsId - 1)); // <|nocaptions|>
    }
    return out;
  };
  let text: string;
  try {
    const out = await asr(clip, {
      language,
      task: 'transcribe',
      return_timestamps: timestamps,
      // Also keeps timestamp mode to one pass over the clip (no seek into the padding).
      max_new_tokens: maxClipTokens(clip.length / 16000),
      logits_processor: [observe],
    } as unknown as Parameters<AutomaticSpeechRecognitionPipeline>[1]);
    text = (Array.isArray(out) ? out[0]! : out).text;
  } finally {
    model.forward = forward;
  }
  if (pending && !looping) {
    // The last step: greedy decoding took the best-scoring token.
    const last: Float32Array = pending;
    let best = 0;
    for (let i = 1; i < last.length; i++) if (last[i]! > last[best]!) best = i;
    settle(best);
  }
  const end = chosen.findIndex((t) => t.id === endId);
  const tokenizer = asr.tokenizer;
  return {
    text,
    // Text tokens come before the special ones (<|endoftext|> and up, timestamps included).
    tokens: (end >= 0 ? chosen.slice(0, end) : chosen)
      .filter((t) => t.id < endId)
      .map((t) => ({ ...t, text: tokenizer.decode([t.id]) })),
    endLogprob: end >= 0 && !looping ? chosen[end]!.logprob : null,
    noSpeechProb: Number.isNaN(noSpeechProb) ? 0 : noSpeechProb,
    detokenize: (ids) => (ids.length ? tokenizer.decode(ids, { skip_special_tokens: true }) : ''),
  };
}

/** Clips at least this long whose two decodes both fail are split in two and tried again. */
const SPLIT_MIN_SECONDS = 8;

/**
 * Transcribes one clip in a known language, keeping Whisper's hallucinations out (see
 * `transcribeChecked`: a doubtful clip costs one more pass). A long clip that Whisper still loops
 * on or is unsure of is cut at its quietest moment near the middle and each half transcribed the
 * same way: on shorter audio Whisper Tiny often recovers the speech (and on noise both halves are
 * dropped again).
 */
export async function transcribeClip(
  asr: AutomaticSpeechRecognitionPipeline,
  clip: Float32Array,
  language: string,
  canSplit = true,
): Promise<string> {
  const seconds = clip.length / 16000;
  if (clip.length > 30 * 16000) {
    // Not used by the worker (clips are cut to ≤ 28 s), so no checks beyond the clean-up.
    const out = await asr(clip, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
    return cleanTranscript(text, seconds);
  }
  const verdict = await transcribeChecked(
    (timestamps) => decodeScored(asr, clip, language, timestamps),
    seconds,
  );
  if (
    !canSplit ||
    seconds < SPLIT_MIN_SECONDS ||
    (verdict.dropped !== 'loop' && verdict.dropped !== 'low-confidence')
  ) {
    return verdict.text;
  }
  // One cut between a third and two thirds of the clip, at its quietest 50 ms.
  const halves = splitLongTurns(clip, [{ speaker: 0, start: 0, end: clip.length }], {
    maxSeconds: (seconds * 2) / 3,
    searchSeconds: seconds / 3,
  });
  const texts: string[] = [];
  for (const half of halves)
    texts.push(await transcribeClip(asr, clip.subarray(half.start, half.end), language, false));
  return texts.filter(Boolean).join(' ');
}
