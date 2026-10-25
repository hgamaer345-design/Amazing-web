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
  create a transcript with speaker labels + automatic language detection (+ `speakers_expected` when
  given), call `onJobCreated(transcriptId)`, poll `GET /v2/transcript/{id}` every
  `providerPollIntervalMs` until `completed`/`error`. Map `utterances` to segments (`speaker` label,
  `start`/`end` ms, `text`); `language_code` → languageCode; `audio_duration` → durationSec. A
  provider "error" status whose message indicates no spoken audio → `no_speech`. `cleanup` →
  `DELETE /v2/transcript/{id}`. `resume` → poll the existing id. **Check the current AssemblyAI API
  docs** (field names, speech model parameters, language-detection + diarization compatibility) and
  follow them.
- **Deepgram**: `POST {baseUrl}/v1/listen?model=…&diarize=true&detect_language=true&punctuate=true&smart_format=true&utterances=true`
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

## Conventions

- Keep modules focused; match the style of the existing files (2-space indent, single quotes,
  semicolons, trailing commas, ~110 col). Comments explain *why*, sparingly.
- No `any` unless unavoidable. No `console.log` in server code — use `log` from `logger.ts`.
- User-visible errors use the messages from `src/shared/errors.ts` (or more specific ones).
- Accessibility: labelled controls, visible focus, keyboard operable menus (Esc closes, focus returns),
  `aria-live` for status changes, colour is never the only signal (speaker names are always shown).
- Tests: colocate as `*.test.ts(x)` next to the code. Server tests use `openDatabase(':memory:')` and
  temp dirs (`fs.mkdtempSync(path.join(os.tmpdir(), '...'))`), and `loadConfig({...})` with an
  explicit env object. Never call real provider APIs in tests — mock `fetch`.
