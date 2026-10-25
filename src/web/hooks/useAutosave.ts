import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ERROR_MESSAGES } from '../../shared/errors';
import { ApiError, conflictDocument } from '../api';
import type { EditableDoc } from '../lib/docOps';

/** pending = edits waiting for the debounce; saving = request in flight; error = last attempt failed. */
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';
export type FlushResult = 'saved' | 'conflict' | 'failed';

export interface AutosaveCallbacks {
  /** Persists `doc` on top of `baseVersion` and resolves with the new server version. */
  save: (doc: EditableDoc, baseVersion: number) => Promise<number>;
  /** Called with the server's latest content after a VERSION_CONFLICT; it becomes the saved baseline. */
  onConflict: (serverDoc: EditableDoc) => void;
}

interface EngineOptions extends AutosaveCallbacks {
  doc: EditableDoc;
  version: number;
  delayMs: number;
  onStatus: (status: SaveStatus, error: string | null) => void;
}

/**
 * Debounced, strictly sequential saving with optimistic concurrency. Documents are immutable, so
 * "has unsaved changes" is just `doc !== saved` (undoing back to the saved object needs no save).
 * Kept outside React so the timers and the in-flight request survive re-renders untouched.
 */
export class AutosaveEngine {
  callbacks: AutosaveCallbacks;
  private doc: EditableDoc;
  private saved: EditableDoc;
  private version: number;
  private readonly delayMs: number;
  private readonly onStatus: EngineOptions['onStatus'];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<FlushResult> | null = null;
  private cancelled = false;
  private detached = false;

  constructor(options: EngineOptions) {
    this.callbacks = { save: options.save, onConflict: options.onConflict };
    this.doc = options.doc;
    this.saved = options.doc;
    this.version = options.version;
    this.delayMs = options.delayMs;
    this.onStatus = options.onStatus;
  }

  get dirty(): boolean {
    return this.doc !== this.saved;
  }

  /** Call whenever the edited document changes. */
  update(doc: EditableDoc): void {
    this.doc = doc;
    if (this.cancelled) return;
    if (!this.dirty) {
      this.clearTimer();
      if (!this.inFlight) this.onStatus('saved', null);
      return;
    }
    // While a request is in flight its completion handler schedules the follow-up save.
    if (this.inFlight) return;
    this.onStatus('pending', null);
    this.schedule();
  }

  /** Saves immediately (after any in-flight request) and reports whether the server is up to date. */
  flush(): Promise<FlushResult> {
    this.clearTimer();
    if (this.inFlight) {
      return this.inFlight.then((result) => (result === 'saved' ? this.flush() : result));
    }
    if (this.cancelled || !this.dirty) return Promise.resolve('saved');
    return this.send();
  }

  /** Stops all saving for good, e.g. because the transcript is being deleted. */
  cancel(): void {
    this.cancelled = true;
    this.clearTimer();
    this.onStatus('saved', null);
  }

  attach(): void {
    this.detached = false;
  }

  /** On unmount (e.g. in-app navigation) unsaved edits are sent right away instead of being lost. */
  detach(): void {
    this.detached = true;
    this.clearTimer();
    if (this.cancelled) return;
    const finalSave = () => {
      if (this.dirty && !this.cancelled)
        void this.callbacks.save(this.doc, this.version).catch(() => undefined);
    };
    if (this.inFlight) void this.inFlight.then(finalSave);
    else finalSave();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private send(): Promise<FlushResult> {
    const sent = this.doc;
    this.onStatus('saving', null);
    const request = this.callbacks
      .save(sent, this.version)
      .then(
        (version): FlushResult => {
          this.version = version;
          this.saved = sent;
          if (this.detached || this.cancelled) return 'saved';
          if (this.dirty) {
            this.onStatus('pending', null);
            this.schedule();
          } else {
            this.onStatus('saved', null);
          }
          return 'saved';
        },
        (err: unknown): FlushResult => {
          const server = conflictDocument(err);
          if (server) {
            const content: EditableDoc = { speakers: server.speakers, rows: server.rows };
            this.version = server.version;
            this.saved = content;
            this.doc = content;
            if (!this.detached && !this.cancelled) {
              this.onStatus('saved', null);
              this.callbacks.onConflict(content);
            }
            return 'conflict';
          }
          if (!this.detached && !this.cancelled) {
            this.onStatus('error', err instanceof ApiError ? err.message : ERROR_MESSAGES.INTERNAL);
          }
          return 'failed';
        },
      )
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }
}

export interface AutosaveOptions extends AutosaveCallbacks {
  /** The live document. The first one passed is treated as already saved at `initialVersion`. */
  doc: EditableDoc;
  initialVersion: number;
  delayMs?: number;
}

export interface Autosave {
  status: SaveStatus;
  /** Message of the last failed save (status "error"). */
  error: string | null;
  /** True while the server doesn't have the latest edits. */
  dirty: boolean;
  flush(): Promise<FlushResult>;
  cancel(): void;
}

export function useAutosave({
  doc,
  initialVersion,
  save,
  onConflict,
  delayMs = 800,
}: AutosaveOptions): Autosave {
  const [state, setState] = useState<{ status: SaveStatus; error: string | null }>({
    status: 'saved',
    error: null,
  });
  const [engine] = useState(
    () =>
      new AutosaveEngine({
        doc,
        version: initialVersion,
        delayMs,
        save,
        onConflict,
        onStatus: (status, error) => setState({ status, error }),
      }),
  );

  useLayoutEffect(() => {
    engine.callbacks = { save, onConflict };
  });

  useEffect(() => {
    engine.update(doc);
  }, [engine, doc]);

  useEffect(() => {
    engine.attach();
    return () => engine.detach();
  }, [engine]);

  const flush = useCallback(() => engine.flush(), [engine]);
  const cancel = useCallback(() => engine.cancel(), [engine]);

  return { status: state.status, error: state.error, dirty: state.status !== 'saved', flush, cancel };
}
