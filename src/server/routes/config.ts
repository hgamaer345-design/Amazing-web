import { Router } from 'express';
import { ACCEPTED_EXTENSIONS, type AppConfigResponse } from '../../shared/types';
import type { AppDeps } from '../app';

/** GET /api/config — what the client needs to know about this server (never any secrets). */
export function configRouter({ config, provider }: AppDeps): Router {
  const router = Router();
  router.get('/config', (_req, res) => {
    const body: AppConfigResponse = {
      provider: config.provider,
      providerConfigured: config.providerConfigured && provider != null,
      maxUploadBytes: config.maxUploadBytes,
      acceptedExtensions: ACCEPTED_EXTENSIONS,
      supportsSpeakerCount: provider?.supportsSpeakerCount ?? false,
      maxSpeakers: config.maxSpeakers,
    };
    res.json(body);
  });
  return router;
}
