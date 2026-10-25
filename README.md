# Speaker Transcriber

Upload a recording, get a transcript **separated by speaker**, fix it up in an editable table while
listening to the audio, and export it as **CSV, Excel, plain text, subtitles or Word**.

**Live demo:** <https://hgamaer345-design.github.io/Amazing-web/> — runs entirely in your browser
with _simulated_ transcription (see [Demo on GitHub Pages](#demo-on-github-pages)). For real
transcripts, run the full app with a speech-to-text API key ([Quick start](#quick-start)).

## Features

- **Upload** by drag-and-drop or file picker: MP3, WAV, M4A, OGG, FLAC and WEBM, up to 500 MB.
  Shows the file name, size and duration, and upload progress.
- **Transcription with speaker diarization** through [AssemblyAI](https://www.assemblyai.com/) or
  [Deepgram](https://deepgram.com/), with automatic language detection.
- **Speaker separation:** a new row starts every time the speaker changes; consecutive sentences from
  the same speaker stay in one row.
- **Results table** with `#`, **Speaker**, **Start** and **End** (`HH:MM:SS`) and **Text** columns.
- **Rename speakers** ("Speaker 1" → "Interviewer"); every row of that speaker updates at once.
- **Playback:** an audio player above the table; click a row to jump to it; the row being played is
  highlighted.
- **Editing:** edit any row's text, merge adjacent rows, reassign a row to another (or a new)
  speaker, with undo/redo and automatic saving.
- **Export** to CSV, XLSX, TXT (`Speaker: text`), SRT subtitles and DOCX.
- **Processing status** (Uploading → Transcribing → Separating speakers → Done) with an estimated time.
- **Colour-coded speakers**, consistent across the table and the exports.
- Optional **"Number of speakers (if known)"** hint before uploading.
- **History** of past transcripts that you can reopen, rename or delete.
- **Responsive** layout that works on phones.
- Clear errors for unsupported or oversized files, failed transcription and "no speech detected".

### Privacy and data

- The speech-to-text **API key stays on the server** (environment variable); it is never sent to the
  browser.
- Uploaded audio is **deleted from the server once processing finishes**, unless you tick
  "Keep audio on the server" (needed only to replay it later from your history).
- With `DELETE_PROVIDER_DATA=true` (the default) the app also asks the provider to delete its copy
  (AssemblyAI deletes the transcript and the uploaded file).
- Everything else lives in `DATA_DIR` (a SQLite database and the uploads folder).

## Quick start

Requires **Node.js 22+**.

```bash
npm install
cp .env.example .env          # then edit .env
```

Set **one** of these in `.env`:

```bash
ASSEMBLYAI_API_KEY=your-key   # recommended: supports the "number of speakers" hint
# DEEPGRAM_API_KEY=your-key
# TRANSCRIPTION_PROVIDER=mock # no key needed: fake transcripts, for trying the app out
```

Development (hot reload): `npm run dev`, then open <http://localhost:5173>.

Production:

```bash
npm run build
npm start                     # http://localhost:3000
```

## Choosing a provider

| Provider       | How to enable                 | Notes                                                                                                                                                                                     |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AssemblyAI** | `ASSEMBLYAI_API_KEY`          | Default when its key is set. Uses `speech_models` `universal-3-5-pro` → `universal-2` fallback. Supports the speaker-count hint. EU: `ASSEMBLYAI_BASE_URL=https://api.eu.assemblyai.com`. |
| **Deepgram**   | `DEEPGRAM_API_KEY`            | `nova-3` with `diarize_model=latest`. Has no speaker-count hint (the field is disabled in the UI).                                                                                        |
| **Mock**       | `TRANSCRIPTION_PROVIDER=mock` | Never chosen automatically. Generates a realistic fake conversation. A file name containing `nospeech` gives "no speech detected"; `fail` gives a failed transcription.                   |

If no provider is configured the app still starts, shows a banner explaining what to set, and keeps
existing transcripts viewable.

## Configuration

All settings are environment variables (a `.env` file in the project root is loaded automatically;
real environment variables take precedence).

| Variable                                  | Default                         | Description                                                                            |
| ----------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `PORT`                                    | `3000`                          | HTTP port (the Vite dev server proxies `/api` to it).                                  |
| `HOST`                                    | `0.0.0.0`                       | Interface to listen on.                                                                |
| `DATA_DIR`                                | `./data`                        | SQLite database (`transcripts.db`) and `uploads/`.                                     |
| `PUBLIC_DIR`                              | `./dist/public`                 | Built web app served by the server.                                                    |
| `MAX_UPLOAD_MB`                           | `500`                           | Maximum upload size.                                                                   |
| `MAX_SPEAKERS`                            | `10`                            | Upper bound for the "number of speakers" field.                                        |
| `TRANSCRIPTION_PROVIDER`                  | auto                            | `assemblyai`, `deepgram` or `mock`. Auto: AssemblyAI if its key is set, else Deepgram. |
| `ASSEMBLYAI_API_KEY`                      | —                               | AssemblyAI API key.                                                                    |
| `ASSEMBLYAI_BASE_URL`                     | `https://api.assemblyai.com`    | Use `https://api.eu.assemblyai.com` for EU data residency.                             |
| `ASSEMBLYAI_SPEECH_MODELS`                | `universal-3-5-pro,universal-2` | Comma-separated `speech_models` priority list.                                         |
| `DEEPGRAM_API_KEY`                        | —                               | Deepgram API key.                                                                      |
| `DEEPGRAM_BASE_URL`                       | `https://api.deepgram.com`      | Deepgram API base URL.                                                                 |
| `DEEPGRAM_MODEL`                          | `nova-3`                        | Deepgram model.                                                                        |
| `DEEPGRAM_DIARIZE_MODEL`                  | `latest`                        | Deepgram `diarize_model` (`latest`, `v1`, `v2`).                                       |
| `MOCK_DELAY_MS`                           | `4000`                          | Simulated processing time for the mock provider.                                       |
| `RUN_WORKER`                              | `true`                          | Run the job worker inside the web server process.                                      |
| `WORKER_CONCURRENCY`                      | `2`                             | Files transcribed in parallel.                                                         |
| `WORKER_POLL_INTERVAL_MS`                 | `1000`                          | How often idle workers check for new jobs.                                             |
| `PROVIDER_POLL_INTERVAL_MS`               | `3000`                          | How often to poll the provider for a running job.                                      |
| `JOB_LEASE_MS`                            | `60000`                         | A job not heartbeated within this window is taken over by another worker.              |
| `JOB_MAX_ATTEMPTS`                        | `3`                             | Attempts for temporary provider/network failures.                                      |
| `JOB_TIMEOUT_MINUTES`                     | `180`                           | Maximum processing time per file.                                                      |
| `DELETE_PROVIDER_DATA`                    | `true`                          | Ask the provider to delete its copy after processing.                                  |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | —                               | Set both to password-protect the whole app (HTTP basic auth).                          |
| `TRUST_PROXY`                             | `false`                         | Set to `true` behind a reverse proxy.                                                  |
| `LOG_LEVEL`                               | `info`                          | `debug`, `info`, `warn` or `error`.                                                    |
| `WEB_PORT`                                | `5173`                          | Vite dev server port (`npm run dev` only).                                             |

## How processing works

1. The browser uploads the file (with progress) to `POST /api/transcripts`. The server streams it to
   disk, checks the file type by its content, reads the duration and queues a job.
2. A background worker picks up the job, sends the audio to the provider with diarization and
   language detection, and waits for the result. Long files never block a web request: the page
   polls `GET /api/transcripts/:id` for the status and estimated time remaining.
3. The worker turns the provider's utterances into rows (a new row at every speaker change), saves
   the transcript and deletes the audio (unless kept).

The job queue lives in SQLite. Workers hold a renewable lease on each job, so if the server restarts
mid-job the job is picked up again and, for AssemblyAI, resumes polling the same provider job instead
of re-uploading. Temporary failures (network errors, rate limits, 5xx) are retried with backoff. Time
estimates start from per-provider defaults and learn from the speed of your past jobs.

To run the worker as a separate process, set `RUN_WORKER=false` for the web server and start
`npm run worker` (after `npm run build`) with the same `DATA_DIR`.

## Demo on GitHub Pages

GitHub Pages can only host static files, so it can't run the server this app needs (it keeps the
API key secret and processes uploads). The repository therefore also builds a **static demo**: the
same interface, but every API call is answered inside the browser — transcription is simulated with
a generated conversation, history is stored in your browser (IndexedDB) and exports are generated
client-side. Nothing is uploaded anywhere.

- Build it locally: `npm run build:pages` (output in `dist/pages`; set `PAGES_BASE=/your-repo/`
  if needed).
- Deployment is automatic: [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds the
  demo on every push to the default branch and publishes it.
- **One-time setup:** in the repository go to **Settings → Pages → Build and deployment**, set
  **Source** to **Deploy from a branch**, branch **`gh-pages`**, folder **`/ (root)`**, and save.
  (Choosing **GitHub Actions** as the source also works.) The site is then served at
  `https://<owner>.github.io/<repo>/`.

## Deployment (full app)

Any host that runs Node.js 22 (or Docker) with a persistent disk works — e.g. a VPS, Render, Fly.io
or Railway. Keep `DATA_DIR` on persistent storage.

**Behind a reverse proxy**, allow large, slow uploads. For nginx:

```nginx
client_max_body_size 600m;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Serve it over **HTTPS**, set `TRUST_PROXY=true`, and set `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` if
the app shouldn't be public (anyone who can open it can see the history).

## API

| Method & path                              | Purpose                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `GET /api/config`                          | Provider status, upload limit, accepted formats.                      |
| `POST /api/transcripts`                    | Upload (multipart: `file`, optional `speakersExpected`, `keepAudio`). |
| `GET /api/transcripts`                     | History, newest first.                                                |
| `GET /api/transcripts/:id`                 | Status, progress/ETA and (when done) the transcript.                  |
| `PUT /api/transcripts/:id/document`        | Save edits (optimistic concurrency via `baseVersion`).                |
| `PATCH /api/transcripts/:id`               | Rename.                                                               |
| `DELETE /api/transcripts/:id`              | Delete the transcript and any stored audio.                           |
| `DELETE /api/transcripts/:id/audio`        | Delete only the stored audio.                                         |
| `POST /api/transcripts/:id/retry`          | Retry a failed job (when its audio is still stored).                  |
| `GET /api/transcripts/:id/audio`           | Stream the audio (supports HTTP Range).                               |
| `GET /api/transcripts/:id/export?format=…` | Download `csv`, `xlsx`, `txt`, `srt` or `docx`.                       |
| `GET /api/health`                          | Health check.                                                         |

Request and response types are defined in [`src/shared/types.ts`](src/shared/types.ts).

## Development

| Command               | What it does                                                    |
| --------------------- | --------------------------------------------------------------- |
| `npm run dev`         | API server (auto-restart) + Vite dev server with hot reload.    |
| `npm run build`       | Build the web app and the server into `dist/`.                  |
| `npm start`           | Run the built server.                                           |
| `npm run worker`      | Run the job worker as its own process.                          |
| `npm run build:pages` | Build the static GitHub Pages demo into `dist/pages`.           |
| `npm run typecheck`   | TypeScript type check.                                          |
| `npm test`            | Unit and integration tests (Vitest).                            |
| `npm run test:e2e`    | Browser end-to-end test against a built app (needs Playwright). |
| `npm run format`      | Format with Prettier.                                           |

```
src/shared/   types (API contract), time formatting, speaker colours, validation, exporters
src/server/   Express app, upload handling, SQLite job queue, worker, speech-to-text providers
src/web/      React app: upload & history, transcript editor, player; demo/ = in-browser backend
docs/         architecture notes
tests/        server test helpers and the end-to-end test
```

More detail on the design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Troubleshooting

- **"Transcription isn't set up on this server"** — no provider is configured; set an API key (see
  [Quick start](#quick-start)) and restart.
- **Uploads fail at a certain size behind a proxy** — raise the proxy's body size limit and timeouts
  (see [Deployment](#deployment-full-app)).
- **Duration shows "—" for a WEBM file** — browser recordings often don't store a duration; the
  transcript still works and the provider reports the length.
- **"No speech was detected"** — the file is silent or too quiet; AssemblyAI needs some clearly
  spoken audio to detect the language.
- **The GitHub Pages site shows 404** — Pages isn't enabled yet; see the one-time setup in
  [Demo on GitHub Pages](#demo-on-github-pages).
