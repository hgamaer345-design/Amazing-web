// Web Worker that turns 16 kHz mono audio into speaker-attributed text, entirely on this
// device: diarization (pyannote segmentation + WeSpeaker embeddings) finds who spoke when, then
// Whisper transcribes each speaker turn.
import { formatBytes } from '../../../shared/time';
import { diarize } from './diarize';
import {
  DIARIZATION_SETTINGS,
  detectLanguage,
  loadSpeakerModels,
  loadWhisper,
  speakerModelRunners,
  transcribeClip,
  WHISPER_MODELS,
} from './models';
import type { SpeechSegment, SpeechStage, WorkerRequest, WorkerResponse } from './protocol';
import { planTurns, speechSample } from './turns';

const SAMPLE_RATE = 16000;
// Share of the whole job each phase represents once the models are available.
const SPEAKERS_SHARE = 0.25;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

class JobError extends Error {
  constructor(
    readonly code: 'NO_SPEECH' | 'MODEL_DOWNLOAD' | 'FAILED',
    message: string,
  ) {
    super(message);
  }
}

async function run({ jobId, audio, options }: WorkerRequest): Promise<void> {
  const progress = (stage: SpeechStage, message: string, fraction: number | null) =>
    post({ type: 'progress', jobId, stage, message, fraction });
  const model = WHISPER_MODELS[options.quality];
  const settings = DIARIZATION_SETTINGS[options.quality];

  progress('loading', 'Preparing speech models…', null);
  let sessions;
  let asr;
  try {
    sessions = await loadSpeakerModels((loaded, total) =>
      progress(
        'loading',
        loaded < total
          ? `Downloading speaker models (${formatBytes(loaded)} of ${formatBytes(total)})…`
          : 'Preparing the speaker models…',
        null,
      ),
    );
    asr = await loadWhisper(options.quality, (loaded, total) =>
      progress(
        'loading',
        loaded < total
          ? `Downloading ${model.label} speech model (${formatBytes(loaded)} of ${formatBytes(total)}) — only needed once…`
          : `Preparing the ${model.label} speech model…`,
        null,
      ),
    );
  } catch (err) {
    throw new JobError('MODEL_DOWNLOAD', err instanceof Error ? err.message : String(err));
  }

  progress('speakers', 'Finding the speakers…', 0);
  const durationSec = audio.length / SAMPLE_RATE;
  // Long recordings use a coarser hop so speaker analysis stays reasonably fast.
  const shiftSec = Math.max(settings.windowShiftSec, Math.ceil(durationSec / 1200));
  const segments = await diarize(
    audio,
    speakerModelRunners(sessions, settings.embedSeconds),
    { windowShift: shiftSec * SAMPLE_RATE, numSpeakers: options.speakersExpected },
    (f) => progress('speakers', `Finding the speakers… ${Math.round(f * 100)}%`, f * SPEAKERS_SHARE),
  );
  const turns = planTurns(segments, audio.length);
  if (turns.length === 0) throw new JobError('NO_SPEECH', 'No speech was detected in this audio.');

  progress('transcribing', 'Detecting the language…', SPEAKERS_SHARE);
  const language = await detectLanguage(asr, speechSample(audio, turns));

  const total = turns.reduce((n, t) => n + (t.end - t.start), 0);
  let done = 0;
  const out: SpeechSegment[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    progress(
      'transcribing',
      `Transcribing turn ${i + 1} of ${turns.length}…`,
      SPEAKERS_SHARE + (1 - SPEAKERS_SHARE) * (done / total),
    );
    const text = await transcribeClip(asr, audio.subarray(turn.start, turn.end), language);
    done += turn.end - turn.start;
    if (text) {
      out.push({
        speaker: `S${turn.speaker}`,
        startMs: Math.round((turn.start / SAMPLE_RATE) * 1000),
        endMs: Math.round((turn.end / SAMPLE_RATE) * 1000),
        text,
      });
    }
  }
  if (out.length === 0) throw new JobError('NO_SPEECH', 'No speech was detected in this audio.');
  post({ type: 'result', jobId, segments: out, languageCode: language, durationSec });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'run') return;
  run(request).catch((err: unknown) => {
    const code = err instanceof JobError ? err.code : 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', jobId: request.jobId, code, message });
  });
};
