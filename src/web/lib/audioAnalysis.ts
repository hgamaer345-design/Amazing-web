// Reads a local audio file's duration and a waveform outline in the browser, before uploading.

/** Files larger than this aren't decoded for a waveform (decoding holds the whole file in memory). */
export const WAVEFORM_MAX_BYTES = 60 * 1024 * 1024;

/**
 * Duration in seconds from an <audio> element, or null if the browser can't tell.
 * MediaRecorder WEBM files often report Infinity until the end has been seeked to.
 */
export function readAudioDuration(url: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      resolve(value != null && Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) {
        finish(audio.duration);
        return;
      }
      // Seeking far past the end makes the browser work out the real duration.
      audio.addEventListener('durationchange', () => {
        if (Number.isFinite(audio.duration)) finish(audio.duration);
      });
      audio.currentTime = 1e101;
    });
    audio.addEventListener('error', () => finish(null));
    audio.src = url;
  });
}

export interface Waveform {
  /** Peak amplitude per bar, 0..1. */
  peaks: number[];
  durationSec: number;
}

/** Decodes the file and returns `bars` peak values, or null when the browser can't decode it. */
export async function decodeWaveform(file: Blob, bars = 160): Promise<Waveform | null> {
  if (file.size > WAVEFORM_MAX_BYTES) return null;
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const size = Math.max(1, Math.floor(data.length / bars));
    const peaks: number[] = [];
    let max = 0;
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      const end = Math.min(data.length, (i + 1) * size);
      // Sampling every 8th value is plenty for an outline and keeps long files fast.
      for (let j = i * size; j < end; j += 8) peak = Math.max(peak, Math.abs(data[j]!));
      peaks.push(peak);
      max = Math.max(max, peak);
    }
    return { peaks: peaks.map((p) => (max > 0 ? p / max : 0)), durationSec: buffer.duration };
  } catch {
    return null;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}
