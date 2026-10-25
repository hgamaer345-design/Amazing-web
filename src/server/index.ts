// Web server entry point (`npm run dev:server`, `npm start`): configuration, database, storage,
// the in-process job worker (unless RUN_WORKER=false) and the HTTP server with graceful shutdown.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { loadConfig, loadDotEnv } from './config';
import { openDatabase, TranscriptRepository } from './db';
import { log } from './logger';
import { createProvider } from './providers';
import { AudioStorage } from './storage';
import { createWorker } from './worker';

// Uploads of up to 500 MB over slow connections can take hours, so there is no overall request
// deadline (Node's default of 300 s would cut them off). Stalled connections are dropped by the
// idle timeout instead, which also triggers cleanup of the partial upload.
const REQUEST_TIMEOUT_MS = 0;
const SOCKET_IDLE_TIMEOUT_MS = 10 * 60_000;
// Longer than the 60 s idle timeout of common load balancers, so they never reuse a closed socket.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
// How long shutdown waits for in-flight requests before closing their connections.
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const db = openDatabase(config.dbPath);
  const repo = new TranscriptRepository(db);
  const storage = new AudioStorage(config.uploadsDir);
  storage.ensureDir();
  await storage.cleanupOrphans(repo.referencedAudioFiles());

  const provider = createProvider(config);
  if (provider) {
    log.info('Transcription provider configured', {
      provider: provider.name,
      supportsSpeakerCount: provider.supportsSpeakerCount,
    });
  } else {
    const why = config.provider
      ? `TRANSCRIPTION_PROVIDER is "${config.provider}" but its API key is not set`
      : 'no API key is set';
    log.warn(
      `Transcription is NOT configured (${why}); uploads will be rejected. Set ASSEMBLYAI_API_KEY or ` +
        'DEEPGRAM_API_KEY, or TRANSCRIPTION_PROVIDER=mock for local testing.',
    );
  }

  const worker = config.worker.enabled ? createWorker({ config, repo, storage, provider }) : null;
  if (worker) worker.start();
  else log.info('In-process worker disabled (RUN_WORKER=false); run `npm run worker` alongside the server.');

  const app = createApp({ config, repo, storage, provider, worker });
  const server = http.createServer(
    {
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    },
    app,
  );
  server.setTimeout(SOCKET_IDLE_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info('Server listening', { url: `http://${shownHost}:${port}`, dataDir: config.dataDir });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) {
      log.warn('Forced exit', { signal });
      process.exit(1);
    }
    stopping = true;
    log.info('Shutting down', { signal });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    force.unref();
    await Promise.all([closed, worker?.stop()]);
    clearTimeout(force);
    db.close();
    log.info('Stopped');
    process.exit(0);
  };
  // `on`, not `once`: a second Ctrl+C forces an immediate exit.
  process.on('SIGINT', (signal) => void shutdown(signal));
  process.on('SIGTERM', (signal) => void shutdown(signal));
}

main().catch((err: unknown) => {
  log.error('Server failed to start', { err });
  process.exit(1);
});
