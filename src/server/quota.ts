import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { nextUtcMidnight, utcDay } from '../shared/quality';
import { QUALITY_MODES, type UsageResponse } from '../shared/types';
import type { AppConfig } from './config';
import type { TranscriptRepository } from './db';

/**
 * Anonymous key that daily quality limits are counted against: a hash of the basic-auth user
 * (when the app is password-protected) and the client IP. Stored hashed so the database never
 * holds raw IP addresses. Behind a reverse proxy, set TRUST_PROXY=true so req.ip is the client.
 */
export function clientKey(req: Request): string {
  let user = '';
  const auth = req.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    user = decoded.slice(0, Math.max(0, decoded.indexOf(':')));
  }
  return createHash('sha256')
    .update(`${user}\u0000${req.ip ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

export function usageFor(
  repo: TranscriptRepository,
  config: AppConfig,
  key: string,
  now: number = Date.now(),
): UsageResponse {
  const day = utcDay(now);
  const modes = Object.fromEntries(
    QUALITY_MODES.map((mode) => [mode, repo.usage(key, mode, day, config.qualityLimits[mode])]),
  ) as UsageResponse['modes'];
  return { day, resetsAt: nextUtcMidnight(now), modes };
}
