import { log } from '../logger';
import { fileBody, providerFetch, readJson, sleep } from './http';
import {
  ProviderError,
  type ProviderResult,
  type ProviderSegment,
  type TranscribeRequest,
  type TranscriptionProvider,
} from './types';

// API reference: https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit
// Flow: POST /v2/upload (raw bytes) -> POST /v2/transcript -> poll GET /v2/transcript/{id}.
// DELETE /v2/transcript/{id} removes the transcript and the uploaded file from AssemblyAI.

export interface AssemblyAiOptions {
  apiKey: string;
  /** https://api.assemblyai.com or https://api.eu.assemblyai.com */
  baseUrl: string;
  /** `speech_models` for High / Ultra High. */
  speechModels: string[];
  /** `speech_models` for Standard. */
  standardSpeechModels: string[];
  pollIntervalMs: number;
  /** Consecutive failed polls tolerated (network blips) before giving up on this attempt. */
  maxPollFailures?: number;
}

interface AaiWord {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
}

interface AaiUtterance {
  speaker: string | null;
  start: number;
  end: number;
  text: string;
}

export interface AaiTranscript {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  error?: string | null;
  text?: string | null;
  utterances?: AaiUtterance[] | null;
  words?: AaiWord[] | null;
  language_code?: string | null;
  audio_duration?: number | null;
}

const LABEL = 'AssemblyAI';
const NO_SPEECH = /no spoken audio|no speech|does not (appear to )?contain (any )?(speech|audio)/i;

/** Converts a completed transcript into provider segments. */
export function mapAssemblyAiTranscript(t: AaiTranscript): ProviderResult {
  let segments: ProviderSegment[];
  if (t.utterances?.length) {
    segments = t.utterances.map((u) => ({
      speaker: u.speaker ?? null,
      startMs: u.start,
      endMs: u.end,
      text: u.text ?? '',
    }));
  } else if (t.words?.length) {
    // No utterances (e.g. diarization unavailable): group words by speaker label instead.
    segments = [];
    for (const w of t.words) {
      const last = segments[segments.length - 1];
      const speaker = w.speaker ?? null;
      if (last && last.speaker === speaker) {
        last.text += ` ${w.text}`;
        last.endMs = w.end;
      } else {
        segments.push({ speaker, startMs: w.start, endMs: w.end, text: w.text });
      }
    }
  } else if (t.text?.trim()) {
    segments = [
      { speaker: null, startMs: 0, endMs: Math.round((t.audio_duration ?? 0) * 1000), text: t.text },
    ];
  } else {
    segments = [];
  }
  return {
    segments,
    languageCode: t.language_code ?? null,
    durationSec: typeof t.audio_duration === 'number' ? t.audio_duration : null,
    ...(t.words?.length
      ? {
          words: t.words.map((w) => ({
            speaker: w.speaker ?? null,
            startMs: w.start,
            endMs: w.end,
            text: w.text,
          })),
        }
      : {}),
  };
}

export function createAssemblyAiProvider(opts: AssemblyAiOptions): TranscriptionProvider {
  const headers = { authorization: opts.apiKey };
  const maxPollFailures = opts.maxPollFailures ?? 5;

  async function poll(id: string, signal: AbortSignal): Promise<ProviderResult> {
    let failures = 0;
    for (;;) {
      let t: AaiTranscript;
      try {
        const res = await providerFetch(
          `${opts.baseUrl}/v2/transcript/${encodeURIComponent(id)}`,
          { headers },
          { label: LABEL, apiKey: opts.apiKey, signal, timeoutMs: 30_000, jobStillValid: true },
        );
        t = await readJson<AaiTranscript>(res, { label: LABEL, jobStillValid: true });
        failures = 0;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof ProviderError && err.status === 404) {
          // The transcript is gone on AssemblyAI's side; start over with a fresh upload.
          throw new ProviderError('transient', `${LABEL} no longer has this transcript`, {
            status: 404,
            detail: err.detail,
            jobStillValid: false,
          });
        }
        if (!(err instanceof ProviderError) || err.kind !== 'transient' || ++failures > maxPollFailures)
          throw err;
        await sleep(Math.max(opts.pollIntervalMs, err.retryAfterMs ?? 0) * failures, signal);
        continue;
      }
      if (t.status === 'completed') return mapAssemblyAiTranscript(t);
      if (t.status === 'error') {
        const detail = t.error ?? 'Unknown error';
        if (NO_SPEECH.test(detail)) throw new ProviderError('no_speech', 'No speech detected', { detail });
        throw new ProviderError('failed', `${LABEL} could not transcribe this audio`, { detail });
      }
      await sleep(opts.pollIntervalMs, signal);
    }
  }

  return {
    name: 'assemblyai',
    supportsSpeakerCount: true,

    async transcribe(req: TranscribeRequest): Promise<ProviderResult> {
      const upload = await providerFetch(
        `${opts.baseUrl}/v2/upload`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: fileBody(req.audioPath),
          duplex: 'half',
        } as RequestInit,
        { label: LABEL, apiKey: opts.apiKey, signal: req.signal },
      );
      const { upload_url: audioUrl } = await readJson<{ upload_url?: string }>(upload, { label: LABEL });
      if (!audioUrl) throw new ProviderError('transient', `${LABEL} did not return an upload URL`);

      const body: Record<string, unknown> = {
        audio_url: audioUrl,
        speech_models: req.quality === 'standard' ? opts.standardSpeechModels : opts.speechModels,
        language_detection: true,
        speaker_labels: true,
      };
      if (req.speakersExpected != null) body.speakers_expected = req.speakersExpected;
      const created = await providerFetch(
        `${opts.baseUrl}/v2/transcript`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        { label: LABEL, apiKey: opts.apiKey, signal: req.signal, timeoutMs: 60_000 },
      );
      const transcript = await readJson<AaiTranscript>(created, { label: LABEL });
      if (!transcript.id) throw new ProviderError('transient', `${LABEL} did not return a transcript id`);
      await req.onJobCreated(transcript.id);
      return poll(transcript.id, req.signal);
    },

    resume(providerJobId: string, signal: AbortSignal): Promise<ProviderResult> {
      return poll(providerJobId, signal);
    },

    async cleanup(providerJobId: string): Promise<void> {
      try {
        await providerFetch(
          `${opts.baseUrl}/v2/transcript/${encodeURIComponent(providerJobId)}`,
          { method: 'DELETE', headers },
          { label: LABEL, apiKey: opts.apiKey, signal: new AbortController().signal, timeoutMs: 30_000 },
        );
      } catch (err) {
        log.warn('Could not delete transcript data from AssemblyAI', {
          providerJobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
