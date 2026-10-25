// Standalone worker process: `npm run worker` (with RUN_WORKER=false on the web process).
// It shares the SQLite database and uploads directory with the web server.
import { loadConfig, loadDotEnv } from './config';
import { openDatabase, TranscriptRepository } from './db';
import { log } from './logger';
import { createProvider } from './providers';
import { AudioStorage } from './storage';
import { createWorker } from './worker';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const provider = createProvider(config);
  if (!provider) {
    log.error(
      'No transcription provider is configured. Set ASSEMBLYAI_API_KEY or DEEPGRAM_API_KEY ' +
        '(or TRANSCRIPTION_PROVIDER=mock for testing).',
    );
    process.exit(1);
  }
  const db = openDatabase(config.dbPath);
  const repo = new TranscriptRepository(db);
  const storage = new AudioStorage(config.uploadsDir);
  storage.ensureDir();
  const worker = createWorker({ config, repo, storage, provider });
  worker.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('Stopping worker', { signal });
    await worker.stop();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('Worker failed to start', { err });
  process.exit(1);
});
