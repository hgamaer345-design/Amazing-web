import { useEffect, useLayoutEffect, useRef } from 'react';

export interface PollingOptions {
  /** Polling runs while true; turning it off cancels the pending tick. */
  enabled: boolean;
  /** Called on each tick. The next tick is scheduled only after it settles, so calls never overlap. */
  poll: () => Promise<unknown> | void;
  /** Delay before the next tick, given the milliseconds since polling was (re)enabled. */
  delayMs: (elapsedMs: number) => number;
}

/** Every ~2 s for the first two minutes, then every ~5 s (long jobs don't need second-level updates). */
export function processingPollDelay(elapsedMs: number): number {
  return elapsedMs < 120_000 ? 2_000 : 5_000;
}

export function usePolling({ enabled, poll, delayMs }: PollingOptions): void {
  const pollRef = useRef(poll);
  const delayRef = useRef(delayMs);
  useLayoutEffect(() => {
    pollRef.current = poll;
    delayRef.current = delayMs;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const schedule = () => {
      timer = setTimeout(
        async () => {
          try {
            await pollRef.current();
          } catch {
            // The poll callback reports its own errors; a failed tick must not stop polling.
          }
          if (!cancelled) schedule();
        },
        delayRef.current(Date.now() - startedAt),
      );
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);
}
