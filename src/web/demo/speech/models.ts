// Model loading for the speech worker: ONNX Runtime set-up, the two speaker models (served from
// this site) and Whisper (downloaded from the Hugging Face hub by transformers.js). Everything
// is cached by the browser after the first run.
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import type { QualityMode } from '../../../shared/types';
import type { DiarizationModels } from './diarize';
import { computeFbank } from './fbank';

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
 * Speaker-analysis settings per mode: hop between 10 s analysis windows and the most speech
 * used per voice fingerprint. Finer settings separate quick exchanges better but cost more.
 */
export const DIARIZATION_SETTINGS: Record<QualityMode, { windowShiftSec: number; embedSeconds: number }> = {
  standard: { windowShiftSec: 2, embedSeconds: 2 },
  high: { windowShiftSec: 1, embedSeconds: 2 },
  ultra: { windowShiftSec: 1, embedSeconds: 5 },
};

const CACHE_NAME = 'speaker-transcriber-models-v1';
let configured = false;

/** Points ONNX Runtime at the WebAssembly files bundled with the site and picks a thread count. */
export function configureRuntime(): void {
  if (configured) return;
  configured = true;
  const wasmPaths = {
    mjs: new URL(ortMjsUrl, self.location.href).href,
    wasm: new URL(ortWasmUrl, self.location.href).href,
  };
  ort.env.wasm.wasmPaths = wasmPaths;
  // Threads need cross-origin isolation (provided by the coi-serviceworker on GitHub Pages).
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1;
  // transformers.js shares this ONNX Runtime instance (and so these settings); Whisper comes from
  // the hub, never from this site's own /models/ folder.
  env.allowLocalModels = false;
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
    ]);
    const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
    return {
      segmentation: await ort.InferenceSession.create(segBytes, options),
      embedding: await ort.InferenceSession.create(embBytes, options),
    };
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
    return (await pipeline('automatic-speech-recognition', WHISPER_MODELS[mode].id, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (info) => {
        if (info.status === 'progress_total') onProgress(info.loaded, info.total);
      },
    })) as AutomaticSpeechRecognitionPipeline;
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
  return text.replace(/\s+/g, ' ').trim();
}
