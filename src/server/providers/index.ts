import type { AppConfig } from '../config';
import { createAssemblyAiProvider } from './assemblyai';
import { createDeepgramProvider } from './deepgram';
import { createMockProvider } from './mock';
import type { TranscriptionProvider } from './types';

/**
 * Returns the configured provider, or null when transcription is not configured
 * (`config.providerConfigured === false`).
 */
export function createProvider(config: AppConfig): TranscriptionProvider | null {
  if (!config.providerConfigured || !config.provider) return null;
  switch (config.provider) {
    case 'assemblyai':
      return createAssemblyAiProvider({
        apiKey: config.assemblyai.apiKey!,
        baseUrl: config.assemblyai.baseUrl,
        speechModels: config.assemblyai.speechModels,
        standardSpeechModels: config.assemblyai.standardSpeechModels,
        pollIntervalMs: config.worker.providerPollIntervalMs,
      });
    case 'deepgram':
      return createDeepgramProvider({
        apiKey: config.deepgram.apiKey!,
        baseUrl: config.deepgram.baseUrl,
        model: config.deepgram.model,
        standardModel: config.deepgram.standardModel,
        diarizeModel: config.deepgram.diarizeModel,
      });
    case 'mock':
      return createMockProvider({ delayMs: config.mock.delayMs });
  }
}
