import fs from 'node:fs';
import express, { type RequestHandler } from 'express';
import { basicAuth } from './auth';
import type { AppConfig } from './config';
import type { TranscriptRepository } from './db';
import { apiNotFound, errorHandler } from './http-utils';
import type { TranscriptionProvider } from './providers/types';
import { configRouter } from './routes/config';
import { downloadsRouter } from './routes/downloads';
import { staticRouter } from './routes/static';
import { transcriptsRouter } from './routes/transcripts';
import type { AudioStorage } from './storage';
import type { JobWorker } from './worker';

export interface AppDeps {
  config: AppConfig;
  repo: TranscriptRepository;
  storage: AudioStorage;
  /** null when transcription is not configured (uploads and retries are then rejected with 503). */
  provider: TranscriptionProvider | null;
  /** In-process worker to wake after an upload or retry; null when the worker runs elsewhere. */
  worker: Pick<JobWorker, 'kick'> | null;
  now?: () => number;
}

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
};

// API responses reflect live state (job progress, edits); never let a browser or proxy cache them.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** The Express application: JSON API under /api plus the built web client. See docs/ARCHITECTURE.md. */
export function createApp(deps: AppDeps): express.Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  // Before authentication so load balancers and uptime checks can reach it.
  app.get('/api/health', noStore, (_req, res) => {
    res.json({ ok: true });
  });
  if (config.basicAuth) app.use(basicAuth(config.basicAuth));

  app.use('/api', noStore);
  app.use('/api', configRouter(deps));
  app.use('/api/transcripts', transcriptsRouter(deps));
  app.use('/api/transcripts', downloadsRouter(deps));
  app.use('/api', apiNotFound);

  if (fs.existsSync(config.publicDir)) app.use(staticRouter(config.publicDir));
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  app.use(errorHandler);
  return app;
}
