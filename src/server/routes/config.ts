import { Router } from 'express';
import { DEFAULT_QUALITY_MODE, qualityModeInfo } from '../../shared/quality';
import { ACCEPTED_EXTENSIONS, type AppConfigResponse } from '../../shared/types';
import type { AppDeps } from '../app';
import { clientKey, usageFor } from '../quota';

/**
 * GET /api/config — what the client needs to know about this server (never any secrets).
 * GET /api/usage  — this visitor's use of limited quality modes today.
 */
export function configRouter({ config, provider, repo, now }: AppDeps): Router {
  const router = Router();
  router.get('/config', (_req, res) => {
    const body: AppConfigResponse = {
      provider: config.provider,
      providerConfigured: config.providerConfigured && provider != null,
      maxUploadBytes: config.maxUploadBytes,
      acceptedExtensions: ACCEPTED_EXTENSIONS,
      supportsSpeakerCount: provider?.supportsSpeakerCount ?? false,
      maxSpeakers: config.maxSpeakers,
      qualityModes: qualityModeInfo(config.qualityLimits),
      defaultQuality: DEFAULT_QUALITY_MODE,
    };
    res.json(body);
  });
  router.get('/usage', (req, res) => {
    res.json(usageFor(repo, config, clientKey(req), (now ?? Date.now)()));
  });
  return router;
}
