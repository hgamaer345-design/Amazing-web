// Web Worker that turns 16 kHz mono audio into speaker-attributed text, entirely on this
// device: diarization (pyannote segmentation + WeSpeaker embeddings) finds who spoke when, Whisper
// detects each speaker's language, and each speaker turn is transcribed by the model that suits
// its language (routing.ts): Whisper, SenseVoice or Omnilingual ASR.
import { formatBytes } from '../../../shared/time';
import type { QualityMode } from '../../../shared/types';
import { diarize } from './diarize';
import { capWasmMemory } from './memoryCap';
import {
  configureRuntime,
  DIARIZATION_SETTINGS,
  isWhisperRecognizer,
  loadRecognizer,
  loadSpeakerModels,
  ModelLoadError,
  RECOGNIZER_INFO,
  speakerModelRunners,
} from './models';
import type { SpeechErrorCode, SpeechSegment, SpeechStage, WorkerRequest, WorkerResponse } from './protocol';
import type { ByteProgress, Recognizer, RecognizerId } from './recognizer';
import {
  chooseRecognizer,
  describeSpeakerLanguages,
  fallbackRecognizer,
  isWhisper,
  LID_MIN_SAMPLE_SECONDS,
  languageName,
  listNames,
  mainLanguage,
  needsOverall,
  qualityWhisper,
  MULTILINGUAL_SURE,
  RECHECK_MIN_SECONDS,
  recheckedLanguage,
  TURN_LID_MIN_SECONDS,
  RECOGNIZER_COST,
  speakerLanguage,
  WHISPER_IDS,
  type LanguageGuess,
  type WhisperId,
} from './routing';
import { planTurns, splitLongTurns, spreadSample, type Turn } from './turns';

const SAMPLE_RATE = 16000;
/**
 * Share of the job (after loading the models) taken by speaker analysis, which costs the same in
 * every mode while Whisper's cost grows with its size; measured on a 5.5-minute interview.
 */
const SPEAKERS_SHARE: Record<QualityMode, number> = { standard: 0.45, high: 0.3, ultra: 0.15 };

/**
 * WebAssembly heap limit on phones (ONNX Runtime declares 4 GiB, which iOS can't back). Standard
 * needs about 300 MB and High about 450 MB; iOS kills a tab at roughly 1–1.5 GB in total.
 */
const LITE_HEAP_BYTES = 768 * 1024 * 1024;

/** ONNX Runtime / Emscripten report exhausted memory in several ways. */
function isOutOfMemory(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /out of memory|\bOOM\b|bad_alloc|memory access out of bounds|Cannot enlarge memory|allocat|RangeError/i.test(
    text,
  );
}

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

export class JobError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function modelError(err: unknown): JobError {
  const message = err instanceof Error ? err.message : String(err);
  return new JobError(
    err instanceof ModelLoadError && err.kind === 'load' ? 'MODEL_LOAD' : 'MODEL_DOWNLOAD',
    message,
  );
}

type Progress = (stage: SpeechStage, message: string, fraction: number | null) => void;

/**
 * The speech-to-text models loaded in this worker, kept between jobs so the next file starts
 * straight away. Only one Whisper size is kept (as loadWhisper does). With `single` (phones) only
 * one model of any kind is kept: the others are freed before another is loaded.
 */
export class RecognizerShelf {
  private readonly loaded = new Map<RecognizerId, Recognizer>();

  constructor(
    private readonly load: (
      id: RecognizerId,
      onProgress: ByteProgress,
    ) => Promise<Recognizer> = loadRecognizer,
  ) {}

  has(id: RecognizerId): boolean {
    return this.loaded.has(id);
  }

  async get(id: RecognizerId, onProgress: ByteProgress, single: boolean): Promise<Recognizer> {
    const ready = this.loaded.get(id);
    if (ready) return ready;
    for (const [other, model] of [...this.loaded]) {
      if (single || (isWhisper(other) && isWhisper(id))) {
        this.loaded.delete(other);
        await model.dispose().catch(() => {});
      }
    }
    const model = await this.load(id, onProgress);
    this.loaded.set(id, model);
    return model;
  }
}

/**
 * What the user sees while a model downloads or starts, e.g. "Detected French (2 speakers) —
 * downloading Whisper Small (34 MB of 249 MB), more accurate for French — only needed once…".
 */
export function loadingMessage(
  label: string,
  loaded: number,
  total: number,
  { prefix = '', why = '', names = '' }: { prefix?: string; why?: string; names?: string } = {},
): string {
  if (loaded < total) {
    const lead = prefix ? `${prefix} — downloading ${label}` : `Downloading the ${label} speech model`;
    return `${lead} (${formatBytes(loaded)} of ${formatBytes(total)})${why} — only needed once…`;
  }
  const lead = prefix ? `${prefix} — preparing ${label}` : `Preparing the ${label} speech model`;
  return `${lead}${names ? ` for ${names}` : ''}…`;
}

/**
 * The speech-to-text models of one job: which one a language gets (with replacements for those
 * that failed to load), and loading them with progress messages.
 */
export class JobModels {
  /** Models that couldn't be loaded in this job: their languages go to the replacement. */
  private readonly failed = new Set<RecognizerId>();
  /** The Whisper that is tried last (it is the quality mode's). */
  readonly lastResort: WhisperId;
  /** The model loaded before speaker analysis (language detection, or the chosen language's). */
  first: RecognizerId;
  /** Job fraction shown while a model loads. */
  fraction: number | null = null;

  constructor(
    private readonly shelf: RecognizerShelf,
    readonly quality: QualityMode,
    readonly lite: boolean,
    private readonly progress: Progress,
    language: string | null,
  ) {
    this.lastResort = qualityWhisper(quality, lite);
    this.first = language ? this.route(language) : this.lastResort;
  }

  route(language: string): RecognizerId {
    const id = chooseRecognizer(language, this.quality, this.lite);
    return this.failed.has(id) ? (this.replacement(id) ?? id) : id;
  }

  /** What replaces `id`, skipping models that already failed in this job. */
  private replacement(id: RecognizerId): RecognizerId | null {
    let next = fallbackRecognizer(id, this.lastResort, this.lite);
    while (next && this.failed.has(next)) next = fallbackRecognizer(next, this.lastResort, this.lite);
    return next;
  }

  isLoaded(id: RecognizerId): boolean {
    return this.shelf.has(id);
  }

  /**
   * Loads `id`, or what replaces it when it can't be loaded (the largest Whisper the device runs,
   * then the quality mode's Whisper). `prefix` starts each message ("Detected French"), `names` the
   * languages it is for.
   */
  async load(id: RecognizerId, prefix = '', names = ''): Promise<Recognizer> {
    let why = names && id !== this.first ? `, more accurate for ${names}` : '';
    // A group planned before its model failed for another group.
    if (this.failed.has(id)) id = this.replacement(id) ?? id;
    for (;;) {
      const { label } = RECOGNIZER_INFO[id];
      try {
        return await this.shelf.get(
          id,
          (loaded, total) =>
            this.progress(
              'loading',
              loadingMessage(label, loaded, total, { prefix, why, names }),
              this.fraction,
            ),
          this.lite,
        );
      } catch (err) {
        this.failed.add(id);
        const next = this.replacement(id);
        if (!next) throw modelError(err);
        why = ` instead of ${label}, which couldn’t be loaded`;
        this.progress(
          'loading',
          `${label} couldn’t be loaded — using ${RECOGNIZER_INFO[next].label} instead…`,
          this.fraction,
        );
        if (this.first === id) this.first = next;
        id = next;
      }
    }
  }
}

/** A speaker turn on its way through the models. */
interface PlannedTurn {
  index: number;
  turn: Turn;
  language: string;
  recognizer: RecognizerId;
  /** Text from an earlier model, kept if the one this turn moved to finds nothing. */
  earlier?: { text: string; language: string };
  /** The turn's own detection set its language: a speaker-wide re-check leaves it alone. */
  ownLanguage?: boolean;
}

export interface SpeakerLanguage {
  speaker: number;
  /** Seconds of speech the detection heard (at most 30). */
  seconds: number;
  /** The speaker's own detection, if they said enough for one. */
  own: LanguageGuess | null;
  /** A larger Whisper's detection that changed the language, if one did. */
  checked?: LanguageGuess;
  language: string;
}

export interface TranscribeResult {
  segments: SpeechSegment[];
  languageCode: string | null;
  speakers: SpeakerLanguage[];
  /** The whole recording's detection, when some speaker needed it. */
  overall: LanguageGuess | null;
  /** Turns whose language was detected again and changed. */
  relanguaged: number;
}

const seconds = (t: Turn) => (t.end - t.start) / SAMPLE_RATE;

/**
 * Transcribes the turns: detects each speaker's language (unless the user chose one), sends each
 * turn to the model for its language, one model at a time (each loaded once), and returns the
 * segments in time order.
 */
export async function transcribeTurns(job: {
  audio: Float32Array;
  turns: Turn[];
  /** The user's choice, or null to detect each speaker's language. */
  language: string | null;
  models: JobModels;
  /** Job fraction when transcription starts. */
  start: number;
  progress: Progress;
  /** Detect each turn's language in multilingual recordings (default true; off to test the rest). */
  turnDetection?: boolean;
}): Promise<TranscribeResult> {
  const { audio, turns, models, start, progress } = job;
  const speakers = [...new Set(turns.map((t) => t.speaker))];
  const turnsOf = (speaker: number) => turns.filter((t) => t.speaker === speaker);
  const languages: SpeakerLanguage[] = [];
  let overall: LanguageGuess | null = null;
  let prefix: string;
  /** Turns whose own detection gave another language than their speaker's. */
  const turnLanguage = new Map<number, string>();
  if (job.language) {
    for (const speaker of speakers)
      languages.push({ speaker, seconds: 0, own: null, language: job.language });
    prefix = languageName(job.language);
  } else {
    models.fraction = start;
    progress(
      'transcribing',
      speakers.length > 1 ? 'Detecting each speaker’s language…' : 'Detecting the language…',
      start,
    );
    const lid = await models.load(models.lastResort);
    if (!isWhisperRecognizer(lid)) throw new JobError('FAILED', 'Language detection needs Whisper.');
    // Each speaker on up to 30 s of their own speech (from its start, middle and end); a speaker
    // who says little and leaves Whisper unsure takes the language detected on the whole recording.
    for (const speaker of speakers) {
      const heard = Math.min(
        30,
        turnsOf(speaker).reduce((n, t) => n + seconds(t), 0),
      );
      const own =
        heard >= LID_MIN_SAMPLE_SECONDS
          ? await lid.detectLanguage(spreadSample(audio, turnsOf(speaker)))
          : null;
      languages.push({ speaker, seconds: heard, own, language: '' });
    }
    if (languages.some((s) => needsOverall(s.own, s.seconds))) {
      overall =
        speakers.length === 1 && languages[0]!.own
          ? languages[0]!.own
          : await lid.detectLanguage(spreadSample(audio, turns));
    }
    for (const s of languages) s.language = speakerLanguage(s.own, s.seconds, overall ?? s.own!);
    prefix = `Detected ${describeSpeakerLanguages(languages.map((s) => s.language))}`;
    // With several languages (or an unsure speaker) a speaker's turns needn't all be in their
    // language: speaker separation can put two people together, and people switch languages. Then
    // each turn long enough for a reliable detection gets its own (one encoder pass each; a
    // single-language recording skips this). A four-language test conversation had Chinese turns
    // sent, as one "Arabic" speaker's, to the Arabic model.
    const speakerLanguageOf = new Map(languages.map((s) => [s.speaker, s.language]));
    if (
      job.turnDetection !== false &&
      (new Set(languages.map((s) => s.language)).size > 1 ||
        languages.some((s) => s.own && s.own.probability < MULTILINGUAL_SURE))
    ) {
      progress('transcribing', 'Checking the language of each turn…', start);
      for (const [index, t] of turns.entries()) {
        if (seconds(t) < TURN_LID_MIN_SECONDS) continue;
        const own = speakerLanguageOf.get(t.speaker)!;
        const other = recheckedLanguage(own, await lid.detectLanguage(audio.subarray(t.start, t.end)));
        if (other) turnLanguage.set(index, other);
      }
      if (turnLanguage.size > 0) {
        const heard = new Map<string, number>();
        turns.forEach((t, i) => {
          const l = turnLanguage.get(i) ?? speakerLanguageOf.get(t.speaker)!;
          heard.set(l, (heard.get(l) ?? 0) + seconds(t));
        });
        const byTime = [...heard].sort((a, b) => b[1] - a[1]).map(([l]) => languageName(l));
        prefix = `Detected ${listNames(byTime)}`;
      }
    }
  }
  const languageOf = new Map(languages.map((s) => [s.speaker, s.language]));

  // One queue per model; the model already loaded first, then the most speech first.
  const planned: PlannedTurn[] = turns.map((turn, index) => {
    const own = turnLanguage.get(index);
    const language = own ?? languageOf.get(turn.speaker)!;
    return { index, turn, language, recognizer: models.route(language), ownLanguage: own !== undefined };
  });
  let relanguaged = turnLanguage.size;
  const speechBy = new Map<RecognizerId, number>();
  for (const p of planned) speechBy.set(p.recognizer, (speechBy.get(p.recognizer) ?? 0) + seconds(p.turn));
  const order = [...speechBy.keys()].sort(
    (a, b) =>
      Number(b === models.first) - Number(a === models.first) ||
      Number(models.isLoaded(b)) - Number(models.isLoaded(a)) ||
      speechBy.get(b)! - speechBy.get(a)!,
  );
  const queue = new Map(order.map((id) => [id, planned.filter((p) => p.recognizer === id)]));
  const singleModel = queue.size === 1 && queue.has(models.first);

  // Progress follows the work left, weighted by each model's speed.
  let doneCost = 0;
  let pendingCost = planned.reduce((n, p) => n + RECOGNIZER_COST[p.recognizer] * seconds(p.turn), 0);
  let fraction = start;
  const advance = () => {
    fraction = Math.max(fraction, start + ((1 - start) * doneCost) / Math.max(1e-9, doneCost + pendingCost));
    models.fraction = fraction;
    return fraction;
  };
  const move = (p: PlannedTurn, to: RecognizerId) => {
    pendingCost += (RECOGNIZER_COST[to] - RECOGNIZER_COST[p.recognizer]) * seconds(p.turn);
    p.recognizer = to;
  };
  const namesOf = (group: PlannedTurn[]) => {
    const by = new Map<string, number>();
    for (const p of group) by.set(p.language, (by.get(p.language) ?? 0) + seconds(p.turn));
    return listNames([...by].sort((a, b) => b[1] - a[1]).map(([l]) => languageName(l)));
  };

  const results: (SpeechSegment | null)[] = turns.map(() => null);
  // The largest Whisper that has detected each speaker's language so far.
  const checkedBy = new Map(speakers.map((s) => [s, WHISPER_IDS.indexOf(models.lastResort)]));
  while (queue.size > 0) {
    const [id, queued] = queue.entries().next().value!;
    queue.delete(id);
    const group = queued;
    const names = namesOf(group);
    advance();
    const model = await models.load(id, prefix, names);
    // A replacement model also takes the turns already waiting for it.
    if (model.id !== id) {
      for (const p of group) move(p, model.id);
      const waiting = queue.get(model.id) ?? [];
      queue.delete(model.id);
      group.push(...waiting);
    }
    if (!job.language && isWhisperRecognizer(model)) {
      // A larger Whisper than the one that detected the languages checks its speakers' language
      // again (Tiny took Ukrainian for Russian with p = 0.93; Base and Small never erred when sure).
      const rank = WHISPER_IDS.indexOf(model.id);
      for (const speaker of new Set(group.map((p) => p.turn.speaker))) {
        if (rank <= checkedBy.get(speaker)!) continue;
        checkedBy.set(speaker, rank);
        const s = languages.find((l) => l.speaker === speaker)!;
        if (s.seconds < LID_MIN_SAMPLE_SECONDS) continue;
        const guess = await model.detectLanguage(spreadSample(audio, turnsOf(speaker)));
        const other = recheckedLanguage(s.language, guess);
        if (!other) continue;
        s.checked = guess;
        s.language = other;
        prefix = `Detected ${describeSpeakerLanguages(languages.map((l) => l.language))}`;
        const target = models.route(other);
        for (const p of [...group, ...[...queue.values()].flat()]) {
          if (p.turn.speaker !== speaker || p.language === other || p.ownLanguage) continue;
          p.language = other;
          if (target === p.recognizer) continue;
          // Out of this group or its queue, into the target's (added at the end if new).
          const from = group.includes(p) ? group : queue.get(p.recognizer)!;
          from.splice(from.indexOf(p), 1);
          move(p, target);
          if (target === model.id) group.push(p);
          else queue.set(target, [...(queue.get(target) ?? []), p]);
        }
      }
      for (const [key, waiting] of queue) if (waiting.length === 0) queue.delete(key);
    }
    group.sort((a, b) => a.turn.start - b.turn.start);
    const message = singleModel ? 'Transcribing…' : `Transcribing ${namesOf(group)} with ${model.label}…`;
    for (const p of group) {
      progress('transcribing', message, advance());
      const clip = audio.subarray(p.turn.start, p.turn.end);
      let text: string;
      let language = p.language;
      if (!job.language && isWhisperRecognizer(model) && seconds(p.turn) >= RECHECK_MIN_SECONDS) {
        // Whisper doubting a turn (a loop, an unlikely text) can mean the speaker changed language.
        const first = await model.transcribeChecked(clip, language);
        text = first.text;
        const other = first.doubtful ? recheckedLanguage(language, await model.detectLanguage(clip)) : null;
        if (other) {
          const target = models.route(other);
          const waiting = target === model.id ? undefined : queue.get(target);
          if (waiting) {
            // The model for that language is still to come: the turn waits for it.
            relanguaged++;
            const earlier = text ? { text, language } : p.earlier;
            move(p, target);
            waiting.push({ ...p, language: other, earlier });
            continue;
          }
          // Otherwise this model, in that language (its own model is done or not needed so far),
          // if Whisper is surer of that text: on music, detection says English with confidence.
          const again = await model.transcribeChecked(clip, other);
          if (again.text && again.confidence > first.confidence) {
            relanguaged++;
            text = again.text;
            language = other;
          }
        }
      } else {
        text = await model.transcribe(clip, language);
      }
      if (!text && p.earlier) ({ text, language } = p.earlier);
      const cost = RECOGNIZER_COST[p.recognizer] * seconds(p.turn);
      pendingCost -= cost;
      doneCost += cost;
      if (text) {
        results[p.index] = {
          speaker: `S${p.turn.speaker}`,
          startMs: Math.round((p.turn.start / SAMPLE_RATE) * 1000),
          endMs: Math.round((p.turn.end / SAMPLE_RATE) * 1000),
          text,
          lang: language,
        };
      }
    }
  }
  const segments = results.filter((s): s is SpeechSegment => s !== null);
  return { segments, languageCode: mainLanguage(segments), speakers: languages, overall, relanguaged };
}

/** Models stay loaded between jobs (the worker lives as long as the page). */
const shelf = new RecognizerShelf();

async function run({ jobId, audio, options }: WorkerRequest): Promise<void> {
  const progress: Progress = (stage, message, fraction) =>
    post({ type: 'progress', jobId, stage, message, fraction });
  const lite = options.lite ?? false;
  const language = options.language || null;
  const settings = DIARIZATION_SETTINGS;
  const speakersShare = SPEAKERS_SHARE[options.quality];

  if (lite) {
    // Phones: a bounded heap turns "iOS killed the tab" into an error we can report.
    capWasmMemory(LITE_HEAP_BYTES);
  }
  configureRuntime(lite);
  progress('loading', 'Preparing speech models…', null);
  const models = new JobModels(shelf, options.quality, lite, progress, language);
  let sessions;
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
  } catch (err) {
    throw modelError(err);
  }
  // The first speech model now, so a download problem shows before the long speaker analysis:
  // the Whisper that detects the languages, or the model for the language the user chose.
  await models.load(models.first, '', language ? languageName(language) : '');

  progress('speakers', 'Finding the speakers…', 0);
  const durationSec = audio.length / SAMPLE_RATE;
  // Long recordings use a coarser hop so speaker analysis stays reasonably fast; it stays well
  // under the 10 s analysis window so every moment is still analysed by several windows.
  const shiftSec = Math.min(5, Math.max(settings.windowShiftSec, Math.ceil(durationSec / 1200)));
  const segments = await diarize(
    audio,
    speakerModelRunners(sessions, settings.embedSeconds),
    {
      windowShift: shiftSec * SAMPLE_RATE,
      embedStride: settings.embedStrideSec * SAMPLE_RATE,
      minEmbedSpeech: settings.minEmbedSpeechSec,
      numSpeakers: options.speakersExpected,
      segmentBatch: lite ? 2 : 8,
    },
    (f) => progress('speakers', 'Finding the speakers…', f * speakersShare),
  );
  // Clips of at most ~28 s: Whisper hears 30 s at a time, and progress moves with every clip.
  const turns = splitLongTurns(audio, planTurns(segments, audio.length));
  if (turns.length === 0) throw new JobError('NO_SPEECH', 'No speech was detected in this audio.');

  const result = await transcribeTurns({ audio, turns, language, models, start: speakersShare, progress });
  if (result.segments.length === 0) throw new JobError('NO_SPEECH', 'No speech was detected in this audio.');
  post({ type: 'result', jobId, segments: result.segments, languageCode: result.languageCode, durationSec });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'run') return;
  run(request).catch((err: unknown) => {
    const code = err instanceof JobError ? err.code : isOutOfMemory(err) ? 'OUT_OF_MEMORY' : 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', jobId: request.jobId, code, message });
  });
};
