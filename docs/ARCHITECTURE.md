# Speaker Transcriber — Architecture & Implementation Spec

Web app: upload audio → speech-to-text with speaker diarization → editable, speaker-separated
transcript table with synced playback → export (CSV, XLSX, TXT, SRT, DOCX). Past transcripts are
kept in a history list.

This document is the contract between modules. Files marked **(done)** already exist and are the
source of truth for their interfaces — read them, don't redefine their types.

## Stack

- Node 22+, TypeScript (strict, `noUncheckedIndexedAccess`), ESM (`"type": "module"`).
- Server: Express 5, busboy (streaming multipart), better-sqlite3, music-metadata, exceljs, docx, zod 4.
- Web: React 19, react-router-dom 7 (`BrowserRouter`, `Routes`, `Route`, `useParams`, `useNavigate`, `Link`),
  Vite 8. Plain CSS (no CSS framework) using the tokens in `src/web/styles/base.css`.
- Tests: Vitest 5 (`npm test`), projects: `server` (node env: `src/server/**/*.test.ts`,
  `src/shared/**/*.test.ts`, `tests/server/**`) and `web` (jsdom: `src/web/**/*.test.{ts,tsx}`),
  globals enabled, Testing Library + jest-dom for the web. HTTP tests use `supertest`.
- Module resolution is `Bundler`: import relative files **without** extensions (`import { x } from './db'`).
  The server is bundled with esbuild for production, run with `tsx` in dev.
- All dependencies are already installed. **Do not run `npm install` or edit `package.json`.**
  If something essential is missing, say so in your final report.

## Directory layout & ownership

```
src/shared/            (done) types.ts (API contract), errors.ts, time.ts, speakers.ts, document.ts
src/server/
  config.ts            (done) env → AppConfig
  logger.ts            (done)
  errors.ts            (done) AppError
  storage.ts           (done) AudioStorage (generated file names under DATA_DIR/uploads)
  db.ts                (done) openDatabase, TranscriptRepository (records + job queue)
  serialize.ts         (done) toSummary / toDetail / buildProgress
  eta.ts               (done) estimateProcessingSeconds
  providers/types.ts   (done) TranscriptionProvider, ProviderResult, ProviderError
  providers/*.ts       [WORKER]  assemblyai.ts, deepgram.ts, mock.ts, http.ts, index.ts (createProvider)
  segmentation.ts      [WORKER]  provider segments → speakers + rows
  worker.ts            [WORKER]  createWorker (job loop)
  worker-main.ts       [WORKER]  standalone worker process entry
  export/*.ts          [EXPORT]  csv.ts, xlsx.ts, txt.ts, srt.ts, docx.ts, index.ts (exportTranscript)
  app.ts               [SERVER]  createApp (Express app factory)
  upload.ts            [SERVER]  streaming multipart upload + validation
  routes/*.ts          [SERVER]  API routes
  auth.ts              [SERVER]  optional HTTP basic auth
  index.ts             [SERVER]  production/dev entry (env, db, worker, listen, shutdown)
src/web/
  main.tsx, App.tsx, api.ts, lib/config.tsx, lib/sessionAudio.ts, lib/speakerStyle.ts,
  styles/base.css      (done)
  pages/HomePage.tsx + components for upload/history            [WEB-HOME]
  components/ProcessingSteps.tsx                                 [WEB-HOME] (used by both pages)
  pages/TranscriptPage.tsx + player/table/editor components     [WEB-EDITOR]
tests/e2e/             end-to-end (Playwright) — written during integration
```

Stub files exist for cross-team interfaces (`providers/index.ts`, `worker.ts`, `export/index.ts`,
`components/ProcessingSteps.tsx`, the two pages). Their exported signatures are the contract:
the owner replaces the body, keeping the signature (adding optional fields is fine).

## Data model

See `src/shared/types.ts`. Key points:

- `TranscriptDocument = { version, speakers: Speaker[], rows: TranscriptRow[] }`.
- `Speaker = { id, name, colorIndex }`. Renaming a speaker changes only `name`; rows reference
  `speakerId`, so renaming updates every row of that speaker automatically.
- `TranscriptRow = { id, speakerId, startMs, endMs, text }` — integer milliseconds, chronological.
  The "#" column is the 1-based index; it is not stored.
- Speakers that no row references are pruned on save by the client (the server accepts either).
- Colours: `colorIndex` → `SPEAKER_COLORS` in `src/shared/speakers.ts` (same colours in UI and exports).
  New speakers get `max(colorIndex)+1`.
- IDs: `makeId('spk')`, `makeId('row')` from `src/shared/speakers.ts`. Never `crypto.randomUUID` in
  browser code (unavailable on plain-HTTP origins).

## Job lifecycle (server)

The `transcripts` table is the job queue (see the class comment in `db.ts`).

1. `POST /api/transcripts` streams the upload to `DATA_DIR/uploads/<uuid>.<ext>.part`, validates it,
   renames to `<uuid>.<ext>`, creates the record with `status='queued'` and an ETA estimate
   (`estimateProcessingSeconds(provider, durationSec, repo.processingStats(provider), sizeBytes)`),
   then calls `worker.kick()` (if an in-process worker exists) and returns 201.
2. The worker (`createWorker`) runs `config.worker.concurrency` slots. Each idle slot calls
   `repo.claimNextJob(workerId, leaseMs)` every `pollIntervalMs` (and immediately on `kick()`).
3. For a claimed job the worker:
   - starts a heartbeat: `repo.renewLease` every `leaseMs/3`. If it returns false (job deleted or
     reclaimed) → abort the job's `AbortController` and stop touching the record.
   - if `attempts > maxAttempts` → `failJob(TRANSCRIPTION_FAILED)` and go to cleanup.
   - if the audio file is missing and there is no `providerJobId` → fail (`TRANSCRIPTION_FAILED`,
     "audio missing").
   - if `providerJobId` is set and the provider has `resume` → `provider.resume(id, signal)`;
     else `provider.transcribe({..., onJobCreated: id => repo.setProviderJobId(...)})`.
   - enforces `jobTimeoutMs` (from `startedAt`) → `TRANSCRIPTION_TIMEOUT`.
   - `repo.markSeparating()`, then `buildDocument(result.segments)` (segmentation.ts).
     No rows / all text empty → `NO_SPEECH`.
   - `repo.completeJob(...)`; if `durationSec` was unknown and the provider reported one, `setDuration`.
4. Errors: `ProviderError` kinds map as documented in `providers/types.ts`. `transient` →
   `repo.requeue(id, workerId, backoffMs, { keepProviderJobId: err.jobStillValid })` with
   exponential backoff (e.g. 5s, 20s, 60s; honour `retryAfterMs`) until `maxAttempts`, then fail with
   `TRANSCRIPTION_FAILED`. Unknown errors → `TRANSCRIPTION_FAILED` (log the error, include a short
   detail, never stack traces or keys). Aborted because the job was deleted → do nothing.
5. Cleanup after a terminal outcome (done or error): unless `keepAudio`, `repo.takeAudioFile(id)` then
   `storage.delete(file)`. If `config.deleteProviderData` and the provider has `cleanup`, call it
   with the provider job id (best effort). On transient requeue, keep the audio.
6. `DELETE /api/transcripts/:id` deletes the record (+ audio file). A worker processing it notices on its
   next heartbeat (renewLease → false), aborts, and deletes any leftovers. Startup runs
   `storage.cleanupOrphans(repo.referencedAudioFiles())`.
7. Restart safety: a job whose lease expires (crash) is reclaimed by `claimNextJob` and resumed from
   `providerJobId` (AssemblyAI) or resubmitted (Deepgram/mock).

The worker can also run as a separate process (`npm run worker`, with `RUN_WORKER=false` on the web
process); everything goes through SQLite, so nothing else changes.

### Segmentation rules (`segmentation.ts`)

`buildDocument(segments: ProviderSegment[]): { speakers: Speaker[]; rows: TranscriptRow[] }`

- Drop segments whose trimmed text is empty. Sort by `startMs` (stable).
- Map raw labels to speakers in order of first appearance: first label → `{ id: 'spk_1', name: 'Speaker 1',
colorIndex: 0 }`, second → `spk_2`/`Speaker 2`/1, … A `null` label continues the previous segment's
  speaker (or `spk_1` if it is the first).
- **A new row starts each time the speaker changes; consecutive segments from the same speaker are
  merged into one row** (text joined with a single space, whitespace normalised, `startMs` of the
  first, `endMs` = max end). Row ids via `makeId('row')`.
- Ensure `endMs >= startMs` and integer ms.

## Providers

Implement against `providers/types.ts`. All HTTP via global `fetch` (Node 22), streaming the file from
disk (`fs.createReadStream` → `Readable.toWeb`, `duplex: 'half'`) — never buffer a 500 MB file in
memory. The API key is only ever read from `AppConfig`, sent in headers, and never logged or returned.

- **AssemblyAI** (default when `ASSEMBLYAI_API_KEY` is set): upload the file (`POST {baseUrl}/v2/upload`),
  create a transcript with `speech_models` (default `["universal-3-5-pro", "universal-2"]`), speaker labels +
  automatic language detection (+ `speakers_expected` when
  given), call `onJobCreated(transcriptId)`, poll `GET /v2/transcript/{id}` every
  `providerPollIntervalMs` until `completed`/`error`. Map `utterances` to segments (`speaker` label,
  `start`/`end` ms, `text`); `language_code` → languageCode; `audio_duration` → durationSec. A
  provider "error" status whose message indicates no spoken audio → `no_speech`. `cleanup` →
  `DELETE /v2/transcript/{id}`. `resume` → poll the existing id. **Check the current AssemblyAI API
  docs** (field names, speech model parameters, language-detection + diarization compatibility) and
  follow them.
- **Deepgram**: `POST {baseUrl}/v1/listen?model=…&diarize_model=latest&detect_language=true&punctuate=true&smart_format=true&utterances=true`
  (`diarize` is deprecated and must not be sent together with `diarize_model`)
  with the file as the body (synchronous; the worker waits). Map `results.utterances` (speaker
  number → label) or fall back to paragraphs/words; `results.channels[0].detected_language`.
  No `speakersExpected` support. No `resume` (resubmit). **Check the current Deepgram docs.**
- **Mock** (`TRANSCRIPTION_PROVIDER=mock`, for local dev, tests and demos — never chosen implicitly):
  waits `config.mock.delayMs` (abortable), produces a deterministic fake conversation covering the
  audio duration (2 speakers, or `speakersExpected`), some consecutive same-speaker segments so
  merging is exercised. Special file-name triggers for testing are fine if documented in the mock
  (e.g. file name containing `nospeech` → zero segments; `fail` → a `failed` ProviderError).
  Mock needs the duration: read it with music-metadata, falling back to 60 s.
- `createProvider(config)` returns the provider for `config.provider` if `config.providerConfigured`,
  else `null`.

## HTTP API (server)

Defined in `src/shared/types.ts`. Additional rules:

- All JSON errors: `ApiErrorBody` with codes/statuses from `src/shared/errors.ts` (`AppError.toBody()`).
  Unknown errors → 500 `INTERNAL` without leaking internals. Unknown `/api/*` route → 404 `NOT_FOUND` JSON.
- `GET /api/config` → `AppConfigResponse` (`supportsSpeakerCount` from the provider; `maxSpeakers`
  from config).
- `POST /api/transcripts` (multipart):
  - If `!config.providerConfigured` → 503 `PROVIDER_NOT_CONFIGURED` **before** reading the body.
  - Reject early via `Content-Length` > max + small multipart overhead → 413 `FILE_TOO_LARGE`.
  - Exactly one file part named `file`; fields `speakersExpected` (int 1..maxSpeakers, optional),
    `keepAudio` ("true"/"false"), `clientDurationSec` (optional positive number).
  - Extension must be one of `ACCEPTED_EXTENSIONS` (case-insensitive) → else 415 `UNSUPPORTED_FILE`.
  - Sniff magic bytes of the first chunk: MP3 (`ID3` or MPEG frame sync `0xFF 0xE?`/`0xFF 0xF?`), WAV
    (`RIFF....WAVE`), M4A/MP4 (`ftyp` at offset 4), OGG (`OggS`), FLAC (`fLaC`), WEBM/Matroska
    (`1A 45 DF A3`). Content not matching any accepted container → 415 `UNSUPPORTED_FILE`
    (a mismatch between extension and container is fine as long as the container is accepted).
  - Enforce `maxUploadBytes` while streaming (busboy `limits.fileSize`; `truncated` → delete partial,
    413 `FILE_TOO_LARGE`). Zero bytes → 400 `EMPTY_FILE`. Client disconnect → delete partial file.
  - Duration via `music-metadata` `parseFile(path, { duration: true })`; parse failure for a file
    that passed sniffing → 422 `UNREADABLE_AUDIO`. If the parsed duration is missing/0/Infinity (common
    for MediaRecorder WEBM), use `clientDurationSec`.
  - `title` = original file name without extension (trimmed, max 200 chars). Store `mimeType` as sent
    by the browser, or a sensible default for the extension.
  - Respond 201 `{ transcript: TranscriptSummary }`.
- `GET /api/transcripts` → newest first. `GET /api/transcripts/:id` → `TranscriptDetail`
  (`toDetail(rec, rec.status === 'done' ? repo.getDocument(id) : null, repo.queuePosition(id))`).
- `PUT /api/transcripts/:id/document` → validate with `saveDocumentRequestSchema` +
  `findDocumentProblems` (400 `INVALID_INPUT` with detail). `repo.saveDocument` → 200
  `{ document }`; conflict → 409 `{ error: { code: 'VERSION_CONFLICT', ... }, document }`;
  not done → 409 `NOT_READY`. JSON body limit ~25 MB.
- `PATCH /api/transcripts/:id` `{ title }` (1..200 chars trimmed).
- `DELETE /api/transcripts/:id` → 204. `DELETE /api/transcripts/:id/audio` → removes stored audio.
- `POST /api/transcripts/:id/retry` → only when `status === 'error'` and audio is stored, else 409
  `CANNOT_RETRY`; re-estimate, `repo.retry`, `worker.kick()`.
- `GET /api/transcripts/:id/audio` → stream with HTTP Range support (`res.sendFile` with the absolute
  path from `storage.absPath`, correct `Content-Type` for the extension), `Cache-Control: private`.
  Missing → 404 `AUDIO_DELETED`.
- `GET /api/transcripts/:id/export?format=…` → `exportTranscript(format, …)` with the current document;
  `Content-Disposition: attachment` with an ASCII fallback **and** RFC 5987 `filename*` (UTF-8) for
  the name `<title>.<ext>`; invalid format → 400; not done → 409 `NOT_READY`.
- `GET /api/health` → `{ ok: true }`.
- Static: serve `config.publicDir` (built web app) with SPA fallback to `index.html` for non-`/api`
  GET requests, if the directory exists.
- Security: optional basic auth on everything (`config.basicAuth`, constant-time compare,
  `WWW-Authenticate` header) except `/api/health`; `x-powered-by` disabled; basic security headers
  (`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`);
  `trust proxy` from config. Never send API keys to the client.

## Exports (`src/server/export`)

`exportTranscript(format, input: ExportInput): Promise<ExportOutput>` (see the stub). Columns/fields
everywhere: `#`, `Speaker` (display name), `Start` and `End` as `HH:MM:SS` (`formatHms`), `Text`.

- **CSV**: RFC 4180 (quote fields containing `"` `,` CR/LF, double quotes), CRLF line endings, UTF-8 with
  BOM (so Excel opens Unicode correctly), header row `#,Speaker,Start,End,Text`. Guard against CSV
  formula injection: prefix cells starting with `=`, `+`, `-`, `@`, tab or CR with `'`.
- **XLSX** (exceljs): sheet "Transcript", bold frozen header row, column widths, wrapped text column,
  speaker name cell coloured with the speaker's `base` colour; times as text `HH:MM:SS`. A second
  sheet "Info" with title, original file, created, duration, language is a nice touch.
- **TXT**: one block per row: `Speaker: text`, blank line between rows. No timestamps. UTF-8, `\n`.
- **SRT**: numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm` (`formatSrtTimestamp`), text prefixed with
  `Speaker: `. Long rows are split into several cues at sentence boundaries (target ≤ ~84 chars per
  cue, ≤ ~7 s), distributing the row's time span proportionally to character counts; cues never
  overlap, `end > start`, and no cue is shorter than ~500 ms where the row allows. Wrap cue text at
  ~42 chars per line (max 2 lines per cue where possible). Blank line between cues.
- **DOCX** (`docx` package): title heading, a metadata line (file name, date, duration, language,
  speakers), then a table `# | Speaker | Start | End | Text` with a bold header row (repeated on
  each page), speaker names in their colour. Use the speaker display names.
- File names are produced by the route; exporters return bytes + content type + extension.

## Web client

Routes (`App.tsx`, done): `/` → `HomePage`, `/t/:id` → `TranscriptPage`.

### HomePage [WEB-HOME]

- Upload card: drag-and-drop zone + "Choose file" button (`<input type=file accept=".mp3,.wav,.m4a,.ogg,.flac,.webm,audio/*">`),
  whole card is a drop target with a visible drag-over state; keyboard accessible.
- Client-side validation before upload with clear messages: extension in `config.acceptedExtensions`
  (`UNSUPPORTED_FILE` message naming the file), size ≤ `config.maxUploadBytes`, non-empty.
- Once a valid file is chosen, show a file card: name, size (`formatBytes`), duration (read in the
  browser via an `<audio>` element on an object URL; handle `Infinity` for WEBM; show "—" while
  unknown/unreadable), and a "Change file" action.
- Options (before upload): "Number of speakers (if known)" — optional number input / select
  (blank = auto-detect, 1..`config.maxSpeakers`), disabled with a note when
  `!config.supportsSpeakerCount`; checkbox "Keep audio on the server after processing" (default
  off, hint: "Otherwise it's deleted once the transcript is ready. Kept audio lets you replay it
  from your history.").
- "Start transcription" button (disabled if `!config.providerConfigured`).
- During upload: `ProcessingSteps` with stage `uploading`, percentage, bytes, upload speed-based ETA,
  and a Cancel button (`handle.abort()`).
- On success: `setSessionAudio(id, file)` then `navigate('/t/' + id)`.
- On failure: show the server's error message (`ApiError.message`) in an alert, keep the file
  selected so the user can retry.
- History list ("Your transcripts"): from `listTranscripts()`, newest first. Each item: title, date
  (locale), duration, status badge (Queued / Transcribing… / Separating speakers… / Done / Failed with
  the error message), speaker count, "audio kept" indicator, link to `/t/:id`, delete button with
  confirm. Auto-refresh every ~4 s while any item is not done/error. Empty state.
  Loading and error states.

### ProcessingSteps [WEB-HOME] (shared)

Stepper with the four stages **Uploading → Transcribing → Separating speakers → Done**, showing
completed / current / upcoming states, the current stage's detail line and an estimated time
(`formatEta`), e.g. "Waiting in queue (position 2)…", "Transcribing — about 2 minutes remaining",
"Taking longer than expected…" when `etaSeconds === 0` but still running. Accessible (`aria-current`,
live region for status text). Props in the stub.

### TranscriptPage [WEB-EDITOR]

- Loads `getTranscript(id)`; polls every ~2 s (back off to ~5 s after 2 min) while status is
  `queued`/`transcribing`/`separating`, rendering `ProcessingSteps`. Handles 404 (not found card).
- `error` status: error card with the message (+ collapsible detail), "Retry" (if `audioAvailable`),
  "Delete", and "Upload another file" (link to `/`).
- `done`:
  - Header: editable title (PATCH), file name, duration, detected language (via
    `Intl.DisplayNames` with fallback to the code), speaker count, created date, save status, export menu.
  - **Audio player** above the table (sticky on scroll): source priority `getSessionAudioUrl(id)` →
    `audioUrl(id)` if `audioAvailable` → otherwise an inline notice "Audio was deleted from the server
    after processing" with an "Attach audio file" picker that plays a local file (object URL).
    Custom controls: play/pause, seek bar, current/total time, ±5 s skip, playback speed
    (0.75–2×). Keyboard: Space toggles play when focus is not in a text field. Optional
    "Follow along" toggle that auto-scrolls the active row into view.
  - **Speakers legend**: one chip per speaker in its colour with row count; click to rename inline
    (Enter saves, Esc cancels; empty name not allowed). Renaming updates all rows instantly.
  - **Table** (`<table>`): columns `#`, `Speaker`, `Start`, `End`, `Text`, actions. Speaker cell shows
    a coloured chip; clicking it opens a menu: rename this speaker, reassign the row to another
    existing speaker, or to a new speaker. Clicking a row (outside interactive controls) seeks the
    audio to `startMs` and plays. The currently playing row (start ≤ t < next start) is highlighted
    (`aria-current`); efficient lookup (binary search), rows memoised so playback doesn't re-render
    the whole table. Text: click an Edit button (or double-click text) to edit in an auto-growing
    textarea; Enter or blur saves... (Shift+Enter for newline is fine too), Esc cancels. Row actions:
    edit text, merge with next row, merge with previous row. Merging joins text with a space, keeps the
    upper row's speaker and id, `startMs = min`, `endMs = max`.
  - Undo / Redo (buttons + Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y when not typing in a field).
  - Autosave: debounce ~800 ms → `saveDocument(id, { baseVersion, speakers, rows })`; show
    "Saving… / All changes saved / Couldn't save — Retry". On `VERSION_CONFLICT` load the server's
    document (`conflictDocument(err)`) and tell the user. Warn on `beforeunload` with unsaved changes.
    Flush pending saves before exporting.
  - **Export menu**: CSV, Excel (.xlsx), Text (.txt), Subtitles (.srt), Word (.docx) → download via
    `exportUrl(id, format)` (after flushing saves).
  - "Delete audio from server" (when kept) and "Delete transcript" actions with confirmation.
- Document operations as pure functions in `src/web/lib/docOps.ts` (rename speaker, reassign row,
  reassign to new speaker, edit text, merge with next/previous, prune unused speakers) with unit
  tests; undo/redo history in a reducer.
- Responsive: under ~720 px the table becomes stacked cards (same DOM, CSS `display: block`), the
  player stays usable (no horizontal scrolling), tap targets ≥ 40 px.

## In-browser transcription (GitHub Pages demo)

The static demo (`VITE_DEMO_MODE`, built by `scripts/build-pages.mjs`) replaces the API with
`src/web/demo/demoApi.ts`: records live in IndexedDB (`store.ts`), jobs run one at a time in upload
order, and a page reload re-queues an unfinished job whose audio is stored. Transcription happens on
the device in `src/web/demo/speech/`:

```
engine.ts          page side: decode the file to 16 kHz mono (OfflineAudioContext), talk to the worker,
                   cancel = terminate the worker
speech.worker.ts   load models → diarize → plan turns (≤ 28 s clips) → detect each speaker's language →
                   transcribe the turns grouped by model (routing.ts), each model loaded once
routing.ts         which model transcribes which language (FLEURS error rates), speaker-language rules,
                   progress weights; pure
recognizer.ts      the contract every speech-to-text model meets (Whisper, SenseVoice, Omnilingual ASR)
diarize.ts         based on sherpa-onnx's pyannote pipeline: segmentation-3.0 on 10 s windows (powerset →
                   3 local speakers), WeSpeaker embeddings, clustering (cluster.ts: Ward linkage plus
                   clean-up; complete linkage for short files), overlap-add, min on/off durations —
                   with the changes below
fbank.ts           Kaldi fbank (80 bins, povey window, snip_edges=false) + per-segment mean
                   normalisation for WeSpeaker
turns.ts           speaker turns → padded, merged clips; long turns cut at the quietest point; samples
                   of speech for language detection
text.ts            clean-up of Whisper's text (sound tags, lone "you" on noise, repetition loops) and the
                   hallucination checks (silence, loops, unlikely text, "Thank you for watching.")
models.ts          ONNX Runtime set-up (self-hosted wasm; threads when cross-origin isolated),
                   speaker models, Whisper via Transformers.js (as a Recognizer), language detection,
                   loadRecognizer for every model
sensevoice.ts,     SenseVoice-Small and Omnilingual ASR 300M (CTC, int8), served from <base>/models/
omnilingual.ts
download.ts        downloads with byte progress, kept in the Cache API
onnxOutputs.ts     drops Whisper's unused attention outputs from the model files before loading
```

Changes from the reference diarization, measured against ground truth. Early tuning used
conversations synthesized with piper TTS voices (2–4 speakers, up to 5.5 min, with and without
overlapping speech); the clustering was then re-tuned on real recordings (below), where TTS voices
proved a poor guide: they vary far less than real voices.

- **Anchor windows** (`embedStride`, 5 s): only every few windows get embeddings; a local speaker in
  another window takes the speaker of an overlapping anchor whose activity agrees with it (IoU ≥ 0.5
  over the shared frames), and gets its own embedding only when none does. This cuts the embedding
  work ~5× (fewer embeddings also keep the clustering quick on long files).
- **Clean, long-enough speech per embedding**: frames where two local speakers overlap are left out
  (as sherpa's C++ version does), and a local speaker needs ≥ 1 s of clean speech for an embedding —
  shorter samples of one voice are often as far apart as two different voices. Shorter ones are
  matched to an anchor or left to the overlapping windows.
- **One window** (≤ 10 s of audio, speaker count unknown): the segmentation model's own local
  speakers are used directly instead of clustering a few short embeddings.
- **Short recordings** (≤ 12 windows, ~30 s): local speakers of the same window are never put in one
  cluster (cannot-link, carried by complete linkage as an infinite distance); with so few
  embeddings two different voices are often closer than the threshold (10–12 s clips: 1 speaker
  found → 2, DER ~30% → ~2–7%). Longer recordings don't use it: there an occasional split of one
  voice into two local speakers would add a phantom speaker.
- A frame is only given to speakers that some window actually voted for, and invalid embeddings
  (non-finite, or from the zero-padded tail) are dropped.
- The same settings for every quality mode (`DIARIZATION_SETTINGS`: 2 s hop, fingerprints from all
  of a speaker's clean speech in the window, up to 10 s). Fingerprints cut to 2 s were cheaper, but
  on real recordings two of them from one person were often further apart than two people.

Clustering on real recordings. The original complete-linkage clustering (cosine distance ≤ 0.5:
two groups merge only if their two most different embeddings are close) worked on TTS voices but
fell apart on real speech: a 2-person interview came out as 6 speakers, AMI meetings with 4
participants as 18–40. Real voices vary with intonation, distance to the microphone and crosstalk,
and a single outlying embedding blocks a merge. Now (`cluster.ts`, `refineClusters`):

- **Mean-normalised features**: each segment's fbank has its per-bin mean subtracted before the
  embedding model, as WeSpeaker's own inference does (sherpa-onnx only does it when the model's
  metadata asks, and this export doesn't). Without it a fingerprint followed the recording level
  and channel: one speaker 20 dB quieter scored cosine 0.82 against himself, two different callers
  0.83; with it, 1.00 and 0.13.

- **Ward linkage** on unit-length embeddings, via the same nearest-neighbour chain (Ward is
  reducible), checked against SciPy. A merge's height grows with the size of both groups, so it
  behaves like a significance test: two halves of one voice stay close however much they speak,
  two voices separate more clearly the more each speaks. The threshold is `min(2.45, 0.4·√n)` for n
  embeddings, since short recordings give too little evidence for the full bar.
- **Clean-up**: a cluster with less than `min(8 s, 10 % of the speech)` is folded into the most
  similar voice (laughter, a cough, crosstalk); clusters whose average voices are ≥ 0.92 alike
  (cosine) are merged (one speaker who moved relative to the microphone); then every embedding gets
  the speaker whose average voice is closest (as pyannote does). A known speaker count skips the
  folding and merging.
- Short recordings (≤ 12 windows) keep complete linkage with cannot-link, as above.

Evaluated with `onnxruntime-node` on 10 real recordings with reference labels (AMI meetings
ES2004a/ES2005a/IS1009a/TS3003a, 5–10 min, 4 speakers; five Earnings-21 phone calls, 2–7 speakers;
a 5.5 min 2-person interview with approximate labels), 4 synthetic conversations, and 12 real
excerpts of 25 s – 2 min. Mean diarization error (DER, no collar): long files 38.7 % → 12.6 %
(real ones 14.9 %), excerpts 36.1 % → 17.0 %; the right number of speakers in 20 of 26 files (was
9); the interview 43 % (6 speakers) → 13 % (2), an AMI meeting 84 % (32 speakers) → 20 % (4).
Remaining weak spots: excerpts of a minute or two with 3–4 speakers who each say little (often
merged), and overlapping speech in meetings (missed speech is ~10–20 % of the AMI error).

- Speaker models are fetched at build time by `scripts/fetch-speech-models.mjs` from sherpa-onnx's
  GitHub releases (SHA-256 pinned) into `vendor/speech-models/` and served from `<base>/models/`.
  Whisper (`Xenova/whisper-{tiny,base,small}`, q8) comes from the Hugging Face hub.
- Transformers.js assumes English unless a language is given, so `detectLanguage` runs one decoder
  step after `<|startoftranscript|>` and turns the language tokens' scores into probabilities
  (softmax over those tokens only, as openai/whisper does); see **Languages** below.
- Quality modes pick the least Whisper size (other languages may get a larger one, see
  **Languages**); long files use a coarser window hop
  (`max(2, ceil(minutes / 20))` seconds, at most 5 s so windows still overlap) to bound the work.
- Whisper always encodes 30 s, so one clip per speaker turn costs a full pass even for a short
  turn. Packing several turns into one pass and splitting the text by timestamps was tried: 1.35×
  faster on a 5.5 min file, but word errors rose from 3.2% to 4.9% (Whisper Tiny), so each turn is
  still transcribed on its own.
- **Hallucinations** (`text.ts` `transcribeChecked`; scores from `models.ts` `decodeScored`):
  Whisper writes fluent text for silence, noise and unclear audio ("Thank you.", "Thank you for
  watching.", repetition loops, invented sentences). Each greedy pass also records, at no extra
  model cost, every chosen token's log-probability and Whisper's no-speech probability (the
  `<|nocaptions|>` score after `<|startoftranscript|>`, read from the first decoder pass as
  openai/whisper does). Then, per clip:
  - no-speech > 0.6 and average log-probability < -1 (openai/whisper's rule): silence, dropped;
  - a run of up to 64 tokens repeated back to back 3+ times, the copies after the first covering
    16+ tokens, is a loop. When one appears during decoding (`loopGuard`) after text Whisper was
    sure of (average ≥ -0.5), only the token that would continue it is banned, so Whisper goes on
    to the rest of the speech (people repeat themselves too: a chant, counting, "No, no, no, …");
    if it loops again, the text is ended there. A loop after unsure text (those on noise and
    unclear speech), or one that fills half the token limit, is ended at once. A sentence said
    three times also counts if Whisper never gets out of it (every sentence from its second copy
    on repeats an earlier one) or the text was cut off;
  - a pass may write `maxClipTokens`: 20 + 16 per second in Latin, Cyrillic, Greek, Han, kana and
    Hangul (FLEURS speech ≤ 6.8 tokens/s), 20 + 48 per second (≤ 440) in other scripts, which the
    tokenizer spends 1–2.7 tokens per character on (Hindi read speech up to 20 tokens/s). A text
    cut off there while Whisper was still writing is decoded again with Whisper's whole budget,
    without timestamps (they take from the same budget); a character a cut splits is dropped;
  - a loop, a cut-off text or an average < -1 gets a second pass with timestamps, which Whisper
    Tiny usually gets right on such clips. The better decode is kept, else the decode with its
    loops taken out: one copy and the text after it if Whisper ended the text itself and its
    tokens after the loop average ≥ -0.5 (the speech around a chant scored ≥ -0.18 on Tiny, text
    around the loops it fell into on meetings and noise ≤ -0.54), else the text up to the loop;
    the clip is dropped if both stay below -1.2. A long clip (≥ 8 s) dropped that way, or whose
    kept text was cut off, is cut at its quietest moment near the middle and both halves tried (a
    cut-off text is kept if a half is cut off too or the halves give less);
  - a known hallucination phrase or credit ("Thank you.", "Thanks for watching.", "Subtitles by
    …", HALLUCINATION_PHRASES) ending a clip is removed unless its tokens average ≥ -0.3: real
    ones scored ≥ -0.12, invented ones ≤ -0.46. One followed by more speech is kept (a sound tag
    such as "[Music]" is not speech). Sentences end at . ! ? and 。！？, not at a dot inside a word
    ("Amara.org", "А.Синецкая", "3.5"); "You" counts only alone ("And you?" is kept).

  Measured per clip against a Parakeet-TDT reference on 637 Whisper Tiny clips (a real 5.5 min
  interview under five diarizations, AMI and earnings-call excerpts, the TTS conversations, real
  background noise): wrong words 1943 → 1066, correct words 5937 → 6189 (24
  lost, in clips whose text was mostly invented), 14% of clips decoded twice, 22% fewer decoder
  steps (loops end early). End to end on six recordings (Tiny): wrong words 1318 → 697, correct
  2054 → 2277, Whisper time −8% (from −28% to +20% per file). Whisper Base: wrong words 455 → 197
  on 237 clips, 3 correct words lost. In TTS German, Spanish, French, Russian and Chinese no real
  sentence was dropped; Hindi on Tiny (character error > 100%) loses most clips as unlikely. Not
  done: an energy check (clips > 20 dB below the recording's median turn were all
  hallucinations, but it only removed 5 more words).

  The loop guard, the token limit per script, the split of cut-off texts and the sentence rules
  above came after a review found real speech lost: a chant ("Go! Go! …") or a sentence said
  three times ended the transcript of its clip, fast Hindi on Small was cut at the token limit
  (240 of 296 characters, ending in a broken character; now whole, in one pass instead of two),
  and Amara.org credits were never removed. Run end to end on the same 637 Tiny clips
  (`transcribeClipChecked` on every clip): wrong words 1078 → 1088 and correct words 6225 → 6284;
  the 10 more wrong words are misheard words in the speech the split recovered in two clips (+52
  correct words there), and no clip lost a correct word. Decoder steps 12482 → 13026 (15% fewer
  than with no filter, 18% before); 808 passes instead of 791. Whisper Base on its 237 clips:
  unchanged.

- After a failed job the worker is replaced (ONNX Runtime may be left unusable, e.g. out of
  memory); model errors are reported either as download problems or as "couldn't start" (memory).
- Memory: the Whisper conversions on the hub also output every layer's attention weights
  (`[1, heads, 1500, 1500]` floats: ~200 MB per 30 s pass for Tiny, ~400 MB for Base, ~1.2 GB for
  Small). ONNX Runtime builds them in its WebAssembly heap, which never shrinks, and copies them
  to JavaScript. `onnxOutputs.ts` removes those outputs from the model file before the session is
  created (a few ms; the transcript is identical): peak tab memory in Chromium went from ~1.25 GB to
  ~0.8 GB in Standard and from ~2 GB to ~0.9 GB in High. Decoding still holds the whole file
  (~30–45 MB per minute while it runs), hence the shorter limit on phones.
- GitHub Pages can't send COOP/COEP headers; `coi-serviceworker` adds them so ONNX Runtime can use
  threads (`SharedArrayBuffer`). Without it everything still works single-threaded.
- Test fixtures were generated with Python reference implementations (`kaldi-native-fbank` for
  `fbank.json`: 0.3 s of speech with `dither=0, snip_edges=False, window_type="povey",
num_bins=80, low_freq=20, high_freq=-400`, input scaled by 32768; `sherpa_onnx.FastClustering` on
  random clustered embeddings for `clusters.json`). The diarization port was checked against
  sherpa-onnx's `OfflineSpeakerDiarization` on a synthesized three-speaker conversation (identical
  turns).

### Languages (in-browser)

Speech in any language is transcribed by the model that suits it; models are downloaded the first
time a language needs them (Cache API / the hub's cache afterwards).

- **Language per speaker** (`speech.worker.ts` `transcribeTurns`). When the user chose no language
  (`SpeechJobOptions.language` null; the upload form's "auto"), the quality mode's Whisper detects
  each speaker's language once, on up to 30 s of that speaker's speech: `spreadSample` takes three
  10 s parts from the start, middle and end of their turns, since recordings often open with music
  or a jingle (a French news programme whose first 30 s are music came out as English with every
  Whisper size). `detectLanguage` returns the code, its probability and the ranked top 5 (softmax
  over the language tokens). A speaker whose detection is unsure (p < 0.8, `LID_CONFIDENT`) and who
  said less than 10 s (`LID_MIN_SECONDS`) takes the language detected on the whole recording (run
  only when some speaker needs it); under 1 s no own detection is tried. Base and Small were right
  every time they were ≥ 0.8 sure (below); unsure detections on 4–7 s clips were wrong 3 times in 7.
  A chosen language skips all detection.
- **Larger-Whisper check**: when a speaker's language sends them to a larger Whisper than the one
  that detected it (Standard detects with Tiny, then French goes to Small), that model detects the
  speaker's language again on the same sample once it is loaded (one encoder pass), and if it is
  ≥ 0.8 sure of another language the speaker's remaining turns move (to that language's model,
  queued at the end if it wasn't planned). Tiny was sure of Russian for two Ukrainian speakers
  (p = 0.93 and 0.82); Small corrects them.
- **Per-turn check**: a Whisper turn of ≥ 3 s whose first decode was doubtful (the hallucination
  filter decoded it again: a loop, cut off, or average log-probability < -1, which is also what
  speech in the wrong language looks like) has its language detected again on that turn; if another
  language wins with p ≥ 0.8 the turn is transcribed in it: by that language's model if its group is
  still to come (the turn joins it, keeping the first text in case that model finds nothing), else
  by the current Whisper, keeping that text only if Whisper is surer of it (higher average
  log-probability; detection says English for music). This catches some turns in another language
  than their speaker's (a speaker who switches, a diarization mix-up): with every turn of the
  constructed conversations forced to one wrong language, 7 of 13 wrong-language turns came out
  doubtful and all 7 were switched to the right language (Base: fr, zh, ar; Small: pl); Russian
  read as Ukrainian, Spanish as English and one French turn were transcribed confidently and stayed.
- **Each turn in multilingual recordings**: when the speakers' languages differ (or one is detected
  with p < 0.9), every turn of 1.5 s or more gets its own detection before transcription (one
  encoder pass each; single-language recordings skip this), and a turn of 8 s or more is heard in
  two parts (its first and last 40 %): if both are sure (p ≥ 0.8) of different languages it is cut
  at the quietest 50 ms of its middle third into two turns. Speaker separation can join two people
  (in a constructed four-language conversation it gave a Chinese and an Arabic speaker one label
  and one turn); without this their Chinese went to the Arabic model. In the browser that
  conversation went from 18.2 % to 11.7 % WER, every turn in the right language and script.
- **Routing** (`routing.ts` `chooseRecognizer(language, quality, lite)`, from Whisper's FLEURS error
  rates, `FLEURS_WER`): Chinese, Cantonese (only as a chosen language: these Whisper sizes have no
  Cantonese token, `whisperLanguage` maps it to Chinese), Japanese and Korean → SenseVoice; English →
  the quality mode's Whisper; other languages → the smallest Whisper with FLEURS WER ≤ 20 % (never
  Tiny: ≤ 20 % only for English and Spanish, and its detection and hallucination checks are weakest
  away from English), at least the quality mode's; where even the largest Whisper the device runs
  stays above 30 % (or FLEURS has no figure, e.g. Basque, Albanian, Latin) → Omnilingual ASR, else
  that Whisper. On a computer: es/pt/de/it → Base; fr, ru, tr, pl, nl, uk, id, ca, ms and the
  20–30 % ones (sv, vi, th, fi, no, tl, ro) → Small; ar, hi, fa, cs, el, ta, sw, bn, hu, da, gl, … →
  Omnilingual; Urdu and Hebrew stay on Small (`WHISPER_SMALL_PREFERRED`: on FLEURS clips Small was
  as good or better there, 43 vs 48 % and 45 vs 45 % WER, and keeps punctuation).
- **Phones** (`lite`): Whisper is capped at Base (`LITE_MAX_WHISPER`: Base needs about 450 MB of
  WebAssembly memory; Small, with three times the weights and twice the layers, would not fit the
  768 MB heap cap, and iOS kills the tab at ~1–1.5 GB), so Ultra High uses Base there and languages
  where Base exceeds 30 % (pl, nl, id, uk, sv, …) go to Omnilingual. SenseVoice and Omnilingual are
  allowed on phones (one encoder pass, no decoder cache) behind one switch, `LITE_USES_CTC_MODELS`.
- **Fallbacks**: a model that can't be loaded (download or start-up error) is replaced by the largest Whisper the
  device runs, then by the quality mode's Whisper; its turns join that model's group, and the
  failure is remembered for the rest of the job. Only when the quality mode's Whisper fails is the
  job an error (MODEL_DOWNLOAD / MODEL_LOAD as before).
- **Loading**: the first model (the detecting Whisper, or the chosen language's model) loads before
  speaker analysis so download problems show early. Turns are then transcribed grouped by model:
  the loaded one first, then the others by amount of speech, each loaded once; results are put
  back in time order and each segment carries `lang`. Models stay loaded between jobs
  (`RecognizerShelf`), one Whisper size at a time; on phones only one model of any kind (the
  previous one is disposed before the next loads). `languageCode` is the language with the most
  speech.
- **Progress**: messages say what happens and why ("Detected English (1 speaker) and French
  (1 speaker) — downloading Whisper Small (34 MB of 249 MB), more accurate for French — only needed
  once…", "Transcribing French with Whisper Small…", "SenseVoice couldn’t be loaded — using Whisper
  Small instead…"). The transcription fraction is weighted by each model's cost per second of
  speech (`RECOGNIZER_COST`: Tiny 1, Base 1.9, Small 4.6 from the Chromium measurements behind
  `SPEAKERS_SHARE`; SenseVoice ~1 and Omnilingual ~4 from their speed relative to Whisper in
  onnxruntime-node, one thread: Tiny 182, Base 287, Small 540, Omnilingual 583, SenseVoice ~116 ms
  per second of audio) and never goes back. Mid-job downloads are reported as stage `loading` with
  the current fraction; `demoApi` leaves that time out of the ETA (and shows none meanwhile), and
  once a stage has moved 5 % of the job its own pace sets the ETA (`estimateRemaining`), since how
  long transcription takes depends on the models the languages need.
- **API** (`demoApi.ts`): `DemoUploadOptions.language` is validated (`isWhisperLanguage` or "yue";
  "auto", "" or null = detect; anything else INVALID_INPUT), stored on the record and returned as
  `TranscriptSummary.requestedLanguage` (older records: null), and passed to the engine. Rows get
  `lang` only when the transcript has more than one language, and then every row has one (the
  language of most of that speaker's speech in the row, `withRowLanguages`): absent means the
  transcript's `languageCode`, so single-language documents, and all older ones, stay exactly as
  before. buildDocument starts a new row where a speaker's language changes.

Measured in onnxruntime-node with the worker's own code (`transcribeTurns`, `models.ts`; one thread)
on 80 recordings, 21 min: a 19-language set (FLEURS and other public samples; two constructed
conversations where each speaker has their own language: ar/en/es/zh with 4 speakers, pl/ru/uk
with 3) and two more constructed two-speaker, two-language conversations (en+fr 46 s, de+hi 55 s;
FLEURS speakers alternating, 6 turns). Reference speaker turns unless noted; WER after NFKC,
lower case and punctuation removal, CER for zh/ja/ko. "CTC" columns use the research prototypes of
SenseVoice and Omnilingual as stand-ins (until their implementations land, those languages get
Whisper Small, the other figures).

| Speakers whose language is right (93) | Tiny | Base | Small |
| ------------------------------------- | ---- | ---- | ----- |
| one detection per file (before)       | 79   | 85   | 85    |
| per speaker, spread sample            | 87   | 93   | 93    |
| + larger-Whisper check                | 91   | 93   | 93    |

In the four mixed-language conversations 4 of 11 speakers were right before, 11 now (every size).
With real diarization on the seven multi-speaker recordings: 13 of 20 → 19–20. Detections with
p ≥ 0.8 were right 92/92 (Base), 88/88 (Small), 83/85 (Tiny: two Ukrainian speakers as Russian).

| WER % before → after (CTC)   | Standard           | High               | Ultra High         |
| ---------------------------- | ------------------ | ------------------ | ------------------ |
| single-language recordings   | 72.5 → 27.1 (22.8) | 52.3 → 25.8 (21.2) | 32.4 → 22.8 (18.2) |
| zh/ja/ko (CER)               | 47.3 → 11.8 (7.4)  | 23.3 → 11.8 (7.4)  | 11.8 → 11.8 (7.4)  |
| mixed-language conversations | 84.0 → 23.5 (21.1) | 60.7 → 19.8 (17.4) | 59.1 → 18.2 (15.8) |

Per language in High (before → Whisper → CTC): French 85 → 23 (a news programme opening with 30 s
of music had been transcribed as English), Ukrainian 47 → 24, Vietnamese 49 → 14, Arabic 63 → 50
→ 34, Persian 83 → 53 → 25, Hindi 105 → 51 → 16, Chinese 36 → 26 → 12 and Japanese 30 → 9 → 8
(CER); English is unchanged (10.0). With real diarization (High) the mixed conversations went from
62.2 to 21.1 (19.8). A phone (Standard, Whisper capped at Base, CTC models allowed): 30.0 WER,
7.4 CER. The price is compute for non-English speech: on this mostly non-English set the
estimated model time (speech seconds × each model's speed) is 2.7× Standard's before (2.1× with
the CTC models), 1.7× High's (1.4×) and the same for Ultra High (0.83×); English costs the same.
The French news reference is itself model-made, and Chinese CER counts traditional-for-simplified
characters as errors.

In the browser (headless Chromium, built site; the four-language conversation, 56 s): on a
computer (High, 4 threads) 92 s including first downloads of Whisper Base, Omnilingual (349 MB) and
SenseVoice (229 MB); as an iPhone (Standard, phone settings) 146 s, with the page's process peaking
at 1.23 GB — three extra models in one job is the worst case, near what iOS allows a tab
(~1–1.5 GB), so long recordings in several languages are better done on a computer.

### Other speech-to-text models (SenseVoice, Omnilingual ASR)

```
recognizer.ts      the Recognizer contract (Whisper, SenseVoice or Omnilingual ASR per language)
sensevoice.ts      SenseVoice-Small int8 (zh, yue, ja, ko): FunASR fbank (fbank.ts SENSEVOICE_FBANK:
                   hamming, snip_edges, up to 8 kHz), LFR 7/6, CMVN and prompt ids from the model's
                   ONNX metadata, one CTC pass; recognize() also returns the language tag it heard
omnilingual.ts     Omnilingual ASR 300M CTC int8 (1,600+ languages): normalised waveform, CTC; no
                   punctuation or capitals (first letter capitalised)
ctc.ts             token tables, greedy CTC (optionally restricted to a script), ONNX metadata reader,
                   fetchCtcModel (manifest -> graph + weight parts + tokens)
download.ts        Cache API downloads; manifests; files checked by size and SHA-256 before caching
```

- **Hosting.** `scripts/fetch-speech-models.mjs` downloads sherpa-onnx's release tarballs
  (`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`,
  `sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12`) and checks the tarballs and
  the extracted model and token files against pinned SHA-256s. It then rewrites each model as its
  graph plus its weights as ONNX external data in parts of at most 45 MB (GitHub refuses files over
  100 MB), each named by its checksum and listed in `manifest.json`. The rewrite is verified byte
  for byte; transcripts are identical. `build-pages.mjs` fails on a file over 100 MB or a site over
  1 GB (it is 690 MB). With the files already in vendor/, a build only re-hashes them (~8 s);
  downloading and unpacking both tarballs took ~4 min here.
- **Why external data.** ONNX Runtime Web copies a model given as one buffer into its WebAssembly
  heap and parses it there, so the heap needed about 2.5× the model: SenseVoice 590 MB after
  loading, Omnilingual 807 MB. With external data each weight is copied once into its final place:
  298 MB and 429 MB. The downloaded parts stay in JavaScript until the session exists, so the tab
  briefly holds about twice the model.
- **Memory while running** (headless Chromium, one thread, heap capped at 768 MB like a phone):
  - SenseVoice: 358 MB after a 30 s clip.
  - Omnilingual: its working memory grows ~10–15 MB per second of audio (the convolutional front
    end runs at 16 kHz). The heap reached 742 MB after a whole 30 s clip and 515 MB with 12 s
    pieces, so phones pass `maxSeconds: OMNILINGUAL_LITE_MAX_SECONDS` (12 s, cut at the quietest
    moment). On FLEURS, cutting cost 0–7 WER points.
  - Renderer peak: 785 MB (SenseVoice) and 880–1,100 MB (Omnilingual).
  - Real-time factor, one thread: ~1.0 (SenseVoice) and ~2.8 (Omnilingual) on a heavily loaded
    4-core machine. Whisper Small was 2.5 on the same machine with onnxruntime-node.
- **Accuracy** (FLEURS dev, 6 clips per language, same clips through Whisper Small q8 with the
  language given):
  - SenseVoice CER: zh 14.8% vs 20.1%, ja 4.1 vs 7.8, ko 6.2 vs 8.5, yue 4.3 vs 19.1 (Whisper
    Small has no Cantonese; run as zh). With auto-detection its language tag was right on 24 of 24.
  - Omnilingual WER: ar 33% vs 43%, hi 31 vs 82, fa 17 vs 52, ta 48 vs 87, sw 19 vs 80, bn 26 vs
    120, he 45 vs 45 (CER 14 vs 20), ur 48 vs 43.
- **Hindi and Urdu scripts.** Omnilingual isn't told the language, and Hindi and Urdu (one spoken
  language) came out in each other's script (Urdu in Devanagari in 3 of 6 clips). A text mostly in
  the sister script is decoded again from the same scores, each wrong-script letter replaced by the
  best letter of the right script. Urdu WER went 78% → 48% (CER 74% → 18%) and Hindi 36% → 31%.
  Text in any other script is kept as written: it means the turn's language label is wrong, and
  forcing letters turned Chinese speech labelled Arabic into nonsense.
- **Noise and silence.** SenseVoice writes only "。" (dropped); Omnilingual writes nothing or a
  lone letter (dropped). Of 16 noise and silence clips, only "啊啊" on two cat-meow clips
  remained.
- **SenseVoice text.** Its number formatting puts spaces around digits in Japanese ("1 日に"), so
  spaces next to Han or kana are removed. It writes Simplified characters, also for Cantonese.
- **Fixture.** `fbank-sensevoice.json` comes from kaldi-native-fbank with `dither=0,
  snip_edges=True, window_type="hamming", num_bins=80, low_freq=20, high_freq=0` on the samples of
  `fbank.json` × 32768, rounded to 4 decimals. The LFR test vectors are sherpa-onnx's
  `lfr-test.cc`.

## Conventions

- Keep modules focused; match the style of the existing files (2-space indent, single quotes,
  semicolons, trailing commas, ~110 col). Comments explain _why_, sparingly.
- No `any` unless unavoidable. No `console.log` in server code — use `log` from `logger.ts`.
- User-visible errors use the messages from `src/shared/errors.ts` (or more specific ones).
- Accessibility: labelled controls, visible focus, keyboard operable menus (Esc closes, focus returns),
  `aria-live` for status changes, colour is never the only signal (speaker names are always shown).
- Tests: colocate as `*.test.ts(x)` next to the code. Server tests use `openDatabase(':memory:')` and
  temp dirs (`fs.mkdtempSync(path.join(os.tmpdir(), '...'))`), and `loadConfig({...})` with an
  explicit env object. Never call real provider APIs in tests — mock `fetch`.
