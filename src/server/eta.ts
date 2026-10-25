import type { ProviderName, QualityMode } from '../shared/types';

/** Relative processing time per quality mode. */
const QUALITY_FACTOR: Record<QualityMode, number> = { standard: 0.7, high: 1, ultra: 1.25 };

/**
 * Rough processing speed per provider, as "seconds of processing per second of audio",
 * plus a fixed overhead (upload to provider, queueing on their side). These are only
 * starting points; once a few jobs have completed, their measured speed is used instead.
 */
const DEFAULTS: Record<ProviderName, { overheadSec: number; perAudioSec: number }> = {
  assemblyai: { overheadSec: 20, perAudioSec: 0.2 },
  deepgram: { overheadSec: 10, perAudioSec: 0.05 },
  mock: { overheadSec: 4, perAudioSec: 0 },
};

/**
 * Estimated total processing seconds for a file of `durationSec` seconds.
 * `history` is recent completed jobs for the same provider (newest first); with 3+ samples
 * the median measured ratio is blended in.
 */
export function estimateProcessingSeconds(
  provider: ProviderName,
  durationSec: number | null,
  history: { durationSec: number; processingSeconds: number }[] = [],
  uploadBytes?: number,
  quality: QualityMode = 'high',
): number | null {
  const d = DEFAULTS[provider];
  const factor = QUALITY_FACTOR[quality];
  if (provider === 'mock') return Math.round(d.overheadSec * factor);
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    // Without a duration, fall back to file size (~1 MB per minute of compressed audio).
    if (!uploadBytes) return null;
    durationSec = (uploadBytes / (1024 * 1024)) * 60;
  }
  let estimate = d.overheadSec + durationSec * d.perAudioSec;
  const samples = history
    .filter((h) => h.durationSec > 0 && h.processingSeconds > 0)
    .map((h) => ({ ratio: h.processingSeconds / h.durationSec, ...h }));
  if (samples.length >= 3) {
    const ratios = samples.map((s) => s.ratio).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)]!;
    const measured = Math.max(d.overheadSec / 2, durationSec * median);
    estimate = (estimate + measured * 2) / 3;
  }
  return Math.round(Math.max(5, estimate * factor));
}
