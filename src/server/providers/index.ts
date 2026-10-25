import type { AppConfig } from '../config';
import type { TranscriptionProvider } from './types';

/**
 * Returns the configured provider, or null when transcription is not configured
 * (`config.providerConfigured === false`).
 * STUB — implemented by the worker/providers team.
 */
export function createProvider(config: AppConfig): TranscriptionProvider | null {
  void config;
  throw new Error('createProvider: not implemented yet');
}
