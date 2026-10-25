// Page-side handle on the speech worker: decodes the file to 16 kHz mono (audio decoding is
// only available on the main thread), runs one job at a time and supports cancelling.
import { makeId } from '../../../shared/speakers';
import type {
  SpeechErrorCode,
  SpeechJobOptions,
  SpeechProgress,
  SpeechResult,
  WorkerResponse,
} from './protocol';

/** UNREADABLE_AUDIO: the browser can't decode the file; DECODE_MEMORY: too long to decode here. */
export class SpeechJobError extends Error {
  constructor(
    readonly code: SpeechErrorCode | 'UNREADABLE_AUDIO' | 'DECODE_MEMORY',
    message: string,
  ) {
    super(message);
    this.name = 'SpeechJobError';
  }
}

export interface SpeechEngine {
  run(
    audio: Blob,
    options: SpeechJobOptions,
    onProgress: (p: SpeechProgress) => void,
  ): { promise: Promise<SpeechResult>; cancel(): void };
}

/** Decodes any browser-supported audio to 16 kHz mono samples. */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  let buffer: AudioBuffer;
  try {
    // An OfflineAudioContext at 16 kHz resamples while decoding.
    const ctx = new OfflineAudioContext(1, 1, 16000);
    buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    // The whole file is decoded at once, so a very long recording can exhaust memory.
    if (name === 'RangeError' || name === 'QuotaExceededError' || /memory|allocat/i.test(String(err))) {
      throw new SpeechJobError('DECODE_MEMORY', `Not enough memory to decode the audio (${String(err)}).`);
    }
    if (name === 'NotReadableError' || name === 'NotFoundError') {
      throw new SpeechJobError('FAILED', `The stored audio could not be read (${String(err)}).`);
    }
    throw new SpeechJobError('UNREADABLE_AUDIO', 'This browser could not decode the audio file.');
  }
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i]! += data[i]! / buffer.numberOfChannels;
  }
  return mono;
}

/** The real engine: one long-lived worker so models stay loaded between files. */
export function createBrowserSpeechEngine(): SpeechEngine {
  let worker: Worker | null = null;
  const getWorker = () =>
    (worker ??= new Worker(new URL('./speech.worker.ts', import.meta.url), {
      type: 'module',
      name: 'speech',
    }));

  return {
    run(audio, options, onProgress) {
      const jobId = makeId('job');
      let cancelled = false;
      let settled = false;
      /** The worker this job was sent to, once it has been. */
      let sentTo: Worker | null = null;
      let reject: ((err: unknown) => void) | null = null;

      const promise = new Promise<SpeechResult>((resolveJob, rejectJob) => {
        const resolve = (result: SpeechResult) => {
          settled = true;
          resolveJob(result);
        };
        const rej = (err: unknown) => {
          settled = true;
          rejectJob(err);
        };
        reject = rej;
        (async () => {
          onProgress({ stage: 'loading', message: 'Reading the audio…', fraction: null });
          const samples = await decodeToMono16k(audio);
          if (cancelled) return;
          const w = getWorker();
          const cleanup = () => {
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
          };
          const onMessage = (e: MessageEvent<WorkerResponse>) => {
            const msg = e.data;
            if (msg.jobId !== jobId) return;
            if (msg.type === 'progress') {
              onProgress({ stage: msg.stage, message: msg.message, fraction: msg.fraction });
              return;
            }
            cleanup();
            if (msg.type === 'result') {
              resolve({
                segments: msg.segments,
                languageCode: msg.languageCode,
                durationSec: msg.durationSec,
              });
              return;
            }
            // After a failure ONNX Runtime can be left unusable (e.g. out of memory), so the next
            // job gets a fresh worker; the models come back from the browser cache.
            if (msg.code !== 'NO_SPEECH') {
              w.terminate();
              if (worker === w) worker = null;
            }
            rej(new SpeechJobError(msg.code, msg.message));
          };
          // An uncaught error (e.g. out of memory) leaves the worker unusable: start afresh next time.
          const onError = (e: ErrorEvent) => {
            cleanup();
            w.terminate();
            if (worker === w) worker = null;
            rej(new SpeechJobError('FAILED', e.message || 'The speech engine stopped unexpectedly.'));
          };
          w.addEventListener('message', onMessage);
          w.addEventListener('error', onError);
          w.postMessage({ type: 'run', jobId, audio: samples, options }, [samples.buffer]);
          sentTo = w;
        })().catch(rej);
      });

      return {
        promise,
        cancel() {
          if (cancelled || settled) return;
          cancelled = true;
          // Terminating is the only way to stop a running model; the next job starts a fresh
          // worker. A job still decoding hasn't reached the worker, which stays warm.
          if (sentTo) {
            sentTo.terminate();
            if (worker === sentTo) worker = null;
          }
          reject?.(new SpeechJobError('FAILED', 'Cancelled.'));
        },
      };
    },
  };
}
