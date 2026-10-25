import path from 'node:path';
import express, { Router } from 'express';

// Vite emits content-hashed file names under /assets, so those can be cached forever.
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves the built web client from `publicDir`, falling back to index.html for client-side
 * routes such as /t/:id. Requests that look like files (have an extension) and don't exist
 * get a 404 instead of the HTML page, so a missing script fails clearly.
 */
export function staticRouter(publicDir: string): Router {
  const root = path.resolve(publicDir);
  const assetsDir = path.join(root, 'assets') + path.sep;
  const indexFile = path.join(root, 'index.html');
  const router = Router();

  router.use(
    express.static(root, {
      index: false,
      redirect: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', filePath.startsWith(assetsDir) ? IMMUTABLE : 'no-cache');
      },
    }),
  );

  router.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || path.posix.extname(req.path)) {
      next();
      return;
    }
    res.sendFile(
      indexFile,
      { headers: { 'Cache-Control': 'no-cache' } },
      (err?: Error & { status?: number }) => {
        if (!err || res.headersSent) return;
        // No index.html (the client hasn't been built): fall through to the 404 handler.
        next(err.status === 404 || (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : err);
      },
    );
  });

  return router;
}
