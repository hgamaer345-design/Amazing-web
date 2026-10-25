import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from './errors';

export interface BasicAuthCredentials {
  user: string;
  password: string;
}

const REALM = 'Speaker Transcriber';

/** Parses an `Authorization: Basic …` header. Returns null when it is missing or malformed. */
export function parseBasicAuth(header: string | undefined): BasicAuthCredentials | null {
  const match = header ? /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})[ \t]*$/i.exec(header) : null;
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

// Comparing fixed-length digests keeps timingSafeEqual's equal-length requirement and doesn't
// reveal the expected lengths.
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * HTTP Basic authentication for every request that reaches it (mount it after the routes that
 * must stay public, such as the health check). Responds 401 UNAUTHORIZED with a
 * `WWW-Authenticate` challenge so browsers show their sign-in prompt.
 */
export function basicAuth(credentials: BasicAuthCredentials): RequestHandler {
  const expectedUser = digest(credentials.user);
  const expectedPassword = digest(credentials.password);
  return (req, res, next) => {
    const supplied = parseBasicAuth(req.headers.authorization);
    if (supplied) {
      // Evaluate both comparisons so the response time doesn't reveal which part was wrong.
      const userOk = timingSafeEqual(digest(supplied.user), expectedUser);
      const passwordOk = timingSafeEqual(digest(supplied.password), expectedPassword);
      if (userOk && passwordOk) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    next(new AppError('UNAUTHORIZED'));
  };
}
