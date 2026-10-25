// Time formatting helpers shared by the UI and the exporters.

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function clampMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

/** 83_456 -> "00:01:23". Seconds are floored. Hours grow past 99 if needed. */
export function formatHms(ms: number): string {
  const totalSeconds = Math.floor(clampMs(ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 83_456 -> "00:01:23,456" (SubRip timestamp). */
export function formatSrtTimestamp(ms: number): string {
  const total = clampMs(ms);
  return `${formatHms(total)},${pad(total % 1000, 3)}`;
}

/** Human-friendly duration from seconds: 3725 -> "1h 2m 5s", 65 -> "1m 5s", 9.4 -> "9s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Rough remaining-time phrase: 20 -> "about 20 seconds", 150 -> "about 3 minutes". */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'estimating…';
  if (seconds <= 5) return 'a few seconds';
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rem ? ` ${rem} min` : ''}`;
}

/** 1536 -> "1.5 KB", 524288000 -> "500 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
