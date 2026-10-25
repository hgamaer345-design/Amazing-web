import { useCallback, useEffect, useState } from 'react';
import type { UsageResponse } from '../../shared/types';
import { getUsage } from '../api';

/** This visitor's use of limited quality modes today; null until loaded (or if it couldn't be). */
export function useUsage(): { usage: UsageResponse | null; refresh: () => Promise<void> } {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const refresh = useCallback(async () => {
    try {
      setUsage(await getUsage());
    } catch {
      // Not fatal: the server still enforces the limit and says so on upload.
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { usage, refresh };
}

/** The current time, updated every `intervalMs` (for countdowns and relative times). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
