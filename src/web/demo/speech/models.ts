// Model loading for the speech worker: ONNX Runtime set-up, the two speaker models (served from
// this site) and Whisper (downloaded from the Hugging Face hub by transformers.js). Everything
// is cached by the browser after the first run.
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { QualityMode } from '../../../shared/types';
import type { DiarizationModels } from './diarize';
import { computeFbank } from './fbank';
import { stripOutputs, UNUSED_WHISPER_OUTPUT } from './onnxOutputs';
import { cleanTranscript } from './text';

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
      const feats = computeFbank(limited);
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

/** Transcribes one clip in a known language. */
export async function transcribeClip(
  asr: AutomaticSpeechRecognitionPipeline,
  clip: Float32Array,
  language: string,
): Promise<string> {
  const long = clip.length > 30 * 16000;
  const out = await asr(clip, {
    language,
    task: 'transcribe',
    ...(long ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
  });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
  return cleanTranscript(text, clip.length / 16000);
}
