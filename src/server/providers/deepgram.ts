import { baseLanguage } from '../../shared/languages';
import { joinText, joinTexts } from '../../shared/text';
import { fileBody, providerFetch, readJson } from './http';
import {
  ProviderError,
  type ProviderResult,
  type ProviderSegment,
  type TranscribeRequest,
  type TranscriptionProvider,
} from './types';

// API reference: https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
// Pre-recorded requests are synchronous: the response carries the finished transcript.
// `diarize_model` replaces the deprecated `diarize` flag (sending both is rejected).

export interface DeepgramOptions {
  apiKey: string;
  baseUrl: string;
  /** Model for High / Ultra High. */
  model: string;
  /** Model for Standard. */
  standardModel: string;
  diarizeModel: string;
}

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DgUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
}

interface DgParagraph {
  speaker?: number;
  start: number;
  end: number;
  sentences?: { text: string }[];
}

export interface DgResponse {
  metadata?: { duration?: number };
  results?: {
    utterances?: DgUtterance[];
    channels?: {
      detected_language?: string;
      alternatives?: {
        transcript?: string;
        words?: DgWord[];
        paragraphs?: { paragraphs?: DgParagraph[] };
      }[];
    }[];
  };
}

const LABEL = 'Deepgram';

const sec = (s: number) => Math.round(s * 1000);
const label = (speaker: number | undefined) => (speaker == null ? null : String(speaker));

/** Deepgram's `language` (a BCP-47 tag) for a Whisper language code: the same, except "jw" is "jv". */
export function deepgramLanguage(code: string | null | undefined): string | null {
  return baseLanguage(code);
}

/** Converts a Deepgram response into provider segments (utterances, else paragraphs, else words). */
export function mapDeepgramResponse(res: DgResponse): ProviderResult {
  const channel = res.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  let segments: ProviderSegment[] = [];
  if (res.results?.utterances?.length) {
    segments = res.results.utterances.map((u) => ({
      speaker: label(u.speaker),
      startMs: sec(u.start),
      endMs: sec(u.end),
      text: u.transcript ?? '',
    }));
  } else if (alt?.paragraphs?.paragraphs?.length) {
    segments = alt.paragraphs.paragraphs.map((p) => ({
      speaker: label(p.speaker),
      startMs: sec(p.start),
      endMs: sec(p.end),
      text: joinTexts((p.sentences ?? []).map((s) => s.text)),
    }));
  } else if (alt?.words?.length) {
    for (const w of alt.words) {
      const text = w.punctuated_word ?? w.word;
      const last = segments[segments.length - 1];
      if (last && last.speaker === label(w.speaker)) {
        last.text = joinText(last.text, text);
        last.endMs = sec(w.end);
      } else {
        segments.push({ speaker: label(w.speaker), startMs: sec(w.start), endMs: sec(w.end), text });
      }
    }
  } else if (alt?.transcript?.trim()) {
    segments = [{ speaker: null, startMs: 0, endMs: sec(res.metadata?.duration ?? 0), text: alt.transcript }];
  }
  return {
    segments,
    languageCode: channel?.detected_language ?? null,
    durationSec: typeof res.metadata?.duration === 'number' ? res.metadata.duration : null,
    ...(alt?.words?.length
      ? {
          words: alt.words.map((w) => ({
            speaker: label(w.speaker),
            startMs: sec(w.start),
            endMs: sec(w.end),
            text: w.punctuated_word ?? w.word,
          })),
        }
      : {}),
  };
}

export function createDeepgramProvider(opts: DeepgramOptions): TranscriptionProvider {
  return {
    name: 'deepgram',
    supportsSpeakerCount: false,

    async transcribe(req: TranscribeRequest): Promise<ProviderResult> {
      const model = req.quality === 'standard' ? opts.standardModel : opts.model;
      const language = deepgramLanguage(req.language);
      const params = new URLSearchParams({
        model,
        diarize_model: opts.diarizeModel,
        ...(language ? { language } : { detect_language: 'true' }),
        punctuate: 'true',
        smart_format: 'true',
        utterances: 'true',
      });
      let res: Response;
      try {
        res = await providerFetch(
          `${opts.baseUrl}/v1/listen?${params}`,
          {
            method: 'POST',
            headers: {
              authorization: `Token ${opts.apiKey}`,
              'content-type': req.mimeType || 'application/octet-stream',
            },
            body: fileBody(req.audioPath),
            duplex: 'half',
          } as RequestInit,
          { label: LABEL, apiKey: opts.apiKey, signal: req.signal },
        );
      } catch (err) {
        // Deepgram answers 400 when the model doesn't offer the chosen language; say which pair it was.
        if (language && err instanceof ProviderError && err.kind === 'failed' && err.status === 400) {
          throw new ProviderError('failed', err.message, {
            status: err.status,
            detail: `${err.detail ?? 'Bad request'} (model "${model}", language "${language}")`,
            cause: err,
          });
        }
        throw err;
      }
      return mapDeepgramResponse(await readJson<DgResponse>(res, { label: LABEL }));
    },
  };
}
