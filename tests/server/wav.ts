// Generates real PCM WAV bytes that music-metadata (and the mock provider) can parse.

export interface WavOptions {
  seconds: number;
  sampleRate?: number;
  channels?: number;
  /** Tone frequency in Hz; 0 writes silence. */
  frequency?: number;
}

/** 16-bit PCM WAV of `seconds` length with a quiet sine tone. */
export function makeWav({ seconds, sampleRate = 8000, channels = 1, frequency = 440 }: WavOptions): Buffer {
  const blockAlign = channels * 2;
  const frames = Math.round(seconds * sampleRate);
  const dataBytes = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const sample = frequency ? Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 2000) : 0;
    for (let c = 0; c < channels; c++) buf.writeInt16LE(sample, 44 + i * blockAlign + c * 2);
  }
  return buf;
}
