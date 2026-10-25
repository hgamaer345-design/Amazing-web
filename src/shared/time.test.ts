import { formatBytes, formatDuration, formatEta, formatHms, formatSrtTimestamp } from './time';

describe('time formatting', () => {
  it('formats HH:MM:SS', () => {
    expect(formatHms(0)).toBe('00:00:00');
    expect(formatHms(83_456)).toBe('00:01:23');
    expect(formatHms(3_600_000 * 12 + 61_000)).toBe('12:01:01');
    expect(formatHms(-5)).toBe('00:00:00');
    expect(formatHms(Number.NaN)).toBe('00:00:00');
  });
  it('formats SRT timestamps', () => {
    expect(formatSrtTimestamp(83_456)).toBe('00:01:23,456');
    expect(formatSrtTimestamp(5)).toBe('00:00:00,005');
  });
  it('formats durations, ETAs and sizes', () => {
    expect(formatDuration(3725)).toBe('1h 2m 5s');
    expect(formatDuration(null)).toBe('—');
    expect(formatEta(3)).toBe('a few seconds');
    expect(formatEta(150)).toBe('about 3 minutes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 MB');
  });
});
