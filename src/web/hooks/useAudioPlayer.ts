import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Playback position in ms, kept outside React state: it changes many times per second and only the
 * few components that display it (or derive the active row from it) subscribe, so the transcript
 * table doesn't re-render on every tick.
 */
export interface TimeStore {
  get(): number;
  set(ms: number): void;
  subscribe(listener: () => void): () => void;
}

export function createTimeStore(initialMs = 0): TimeStore {
  let value = initialMs;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(ms) {
      const next = Number.isFinite(ms) && ms > 0 ? ms : 0;
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePlaybackTime(store: TimeStore): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type AudioStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface AudioPlayer {
  /** Attach to the <audio> element. */
  audioRef: (el: HTMLAudioElement | null) => void;
  time: TimeStore;
  status: AudioStatus;
  playing: boolean;
  /** Media duration, else the fallback (WEBM from MediaRecorder often reports Infinity). */
  durationMs: number | null;
  rate: number;
  toggle(): void;
  play(): void;
  pause(): void;
  seek(ms: number, options?: { play?: boolean }): void;
  skip(deltaMs: number): void;
  setRate(rate: number): void;
}

export interface AudioPlayerOptions {
  src: string | null;
  fallbackDurationMs: number | null;
  /** Called when the current source fails to load or decode. */
  onError?: (src: string, message: string) => void;
}

function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return 'The audio couldn’t be loaded. Check your connection and try again.';
    case 3:
      return 'The audio file couldn’t be decoded. It may be damaged.';
    case 4:
      return 'The audio couldn’t be loaded, or this browser can’t play this format.';
    default:
      return 'The audio couldn’t be played.';
  }
}

function startPlayback(el: HTMLMediaElement): void {
  try {
    // play() rejects when interrupted by a new load or blocked by autoplay policy; both are harmless.
    el.play().catch(() => undefined);
  } catch {
    // Engines without a promise-returning play() throw synchronously instead.
  }
}

export function useAudioPlayer({ src, fallbackDurationMs, onError }: AudioPlayerOptions): AudioPlayer {
  const elRef = useRef<HTMLAudioElement | null>(null);
  const [el, setEl] = useState<HTMLAudioElement | null>(null);
  const [time] = useState(createTimeStore);
  const [status, setStatus] = useState<AudioStatus>(src ? 'loading' : 'empty');
  const [playing, setPlaying] = useState(false);
  const [mediaDurationMs, setMediaDurationMs] = useState<number | null>(null);
  const [rate, setRateState] = useState(1);
  const rateRef = useRef(1);
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    onErrorRef.current = onError;
  });

  const audioRef = useCallback((node: HTMLAudioElement | null) => {
    elRef.current = node;
    setEl(node);
  }, []);

  useEffect(() => {
    if (!el) return undefined;
    setStatus(src ? 'loading' : 'empty');
    setPlaying(false);
    setMediaDurationMs(null);
    // A new source resets the playback rate to the default; keep the user's choice.
    el.defaultPlaybackRate = rateRef.current;
    el.playbackRate = rateRef.current;

    let frame = 0;
    const syncTime = () => time.set(el.currentTime * 1000);
    const tick = () => {
      syncTime();
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      syncTime();
    };
    const onMetadata = () => {
      const d = el.duration;
      setMediaDurationMs(Number.isFinite(d) && d > 0 ? d * 1000 : null);
      setStatus('ready');
    };
    const onFailure = () => {
      if (!src) return;
      setStatus('error');
      setPlaying(false);
      cancelAnimationFrame(frame);
      onErrorRef.current?.(src, mediaErrorMessage(el.error));
    };

    syncTime();
    if (src && el.readyState >= 1) onMetadata();
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onPause);
    el.addEventListener('timeupdate', syncTime);
    el.addEventListener('seeked', syncTime);
    el.addEventListener('loadedmetadata', onMetadata);
    el.addEventListener('durationchange', onMetadata);
    el.addEventListener('error', onFailure);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onPause);
      el.removeEventListener('timeupdate', syncTime);
      el.removeEventListener('seeked', syncTime);
      el.removeEventListener('loadedmetadata', onMetadata);
      el.removeEventListener('durationchange', onMetadata);
      el.removeEventListener('error', onFailure);
    };
  }, [el, src, time]);

  const durationMs = mediaDurationMs ?? fallbackDurationMs;
  const durationRef = useRef(durationMs);
  useLayoutEffect(() => {
    durationRef.current = durationMs;
  });

  const usable = useCallback((): HTMLAudioElement | null => {
    const node = elRef.current;
    return node && node.getAttribute('src') ? node : null;
  }, []);

  const play = useCallback(() => {
    const node = usable();
    if (node) startPlayback(node);
  }, [usable]);

  const pause = useCallback(() => usable()?.pause(), [usable]);

  const toggle = useCallback(() => {
    const node = usable();
    if (!node) return;
    if (node.paused || node.ended) startPlayback(node);
    else node.pause();
  }, [usable]);

  const seek = useCallback(
    (ms: number, options?: { play?: boolean }) => {
      const node = usable();
      if (!node) return;
      const max = durationRef.current;
      const target = Math.max(0, max != null ? Math.min(ms, max) : ms);
      node.currentTime = target / 1000;
      time.set(target);
      if (options?.play) startPlayback(node);
    },
    [usable, time],
  );

  const skip = useCallback((deltaMs: number) => seek(time.get() + deltaMs), [seek, time]);

  const setRate = useCallback(
    (next: number) => {
      rateRef.current = next;
      setRateState(next);
      const node = elRef.current;
      if (node) {
        node.defaultPlaybackRate = next;
        node.playbackRate = next;
      }
    },
    [],
  );

  return { audioRef, time, status, playing, durationMs, rate, toggle, play, pause, seek, skip, setRate };
}
