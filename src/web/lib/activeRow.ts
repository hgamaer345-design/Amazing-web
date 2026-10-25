/**
 * Index of the row being spoken at `timeMs`: the last row whose start is <= timeMs, i.e.
 * start <= t < next start. `starts` must be sorted ascending (rows are chronological).
 * Returns -1 before the first row (or for a non-finite time). O(log n), since this runs on
 * every playback tick.
 */
export function findActiveRowIndex(starts: readonly number[], timeMs: number): number {
  if (!Number.isFinite(timeMs)) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] as number) <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
