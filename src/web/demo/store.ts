// Browser persistence for the static demo: IndexedDB, falling back to memory where it is
// unavailable (some private-browsing modes).
import type {
  QualityMode,
  Speaker,
  TranscriptError,
  TranscriptRow,
  TranscriptStatus,
} from '../../shared/types';

export interface DemoRecord {
  id: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  speakersExpected: number | null;
  quality: QualityMode;
  /** UTC day the job counts against for daily quality limits. */
  quotaDay: string;
  keepAudio: boolean;
  /** Whether an audio blob is stored for this record. */
  hasAudio: boolean;
  createdAt: string;
  updatedAt: string;
  status: TranscriptStatus;
  /** When processing started (ISO), null while queued. */
  startedAt: string | null;
  completedAt: string | null;
  /** Processing runs started since the last upload or retry (a run cut short by a crash counts). */
  attempts?: number;
  /** Identifies the current processing run; results of an older run are discarded. */
  runId?: string | null;
  /** Language the user said the recording is in; null or absent (older records) = detected. */
  requestedLanguage?: string | null;
  languageCode: string | null;
  error: TranscriptError | null;
  document: { version: number; speakers: Speaker[]; rows: TranscriptRow[] } | null;
}

export interface DemoStore {
  all(): Promise<DemoRecord[]>;
  get(id: string): Promise<DemoRecord | undefined>;
  put(record: DemoRecord): Promise<void>;
  /**
   * Reads, changes and writes one record atomically. `change` edits the record in place, or
   * returns false to leave it alone. Resolves with the saved record, or undefined if there was
   * none or nothing was saved.
   */
  update(id: string, change: (record: DemoRecord) => boolean | void): Promise<DemoRecord | undefined>;
  delete(id: string): Promise<void>;
  getAudio(id: string): Promise<Blob | undefined>;
  putAudio(id: string, audio: Blob): Promise<void>;
  deleteAudio(id: string): Promise<void>;
}

const DB_NAME = 'speaker-transcriber-demo';
const RECORDS = 'transcripts';
const AUDIO = 'audio';

/** Resolves once the transaction has committed (Blob writes and quota checks happen at commit). */
function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The IndexedDB transaction was aborted.'));
  });
}

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(RECORDS, { keyPath: 'id' });
      req.result.createObjectStore(AUDIO);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

function indexedDbStore(db: IDBDatabase): DemoStore {
  const run = async <T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    await completion(tx);
    return req.result;
  };
  return {
    all: () => run(RECORDS, 'readonly', (s) => s.getAll() as IDBRequest<DemoRecord[]>),
    get: (id) => run(RECORDS, 'readonly', (s) => s.get(id) as IDBRequest<DemoRecord | undefined>),
    put: async (record) => {
      await run(RECORDS, 'readwrite', (s) => s.put(record));
    },
    update: async (id, change) => {
      const tx = db.transaction(RECORDS, 'readwrite');
      const records = tx.objectStore(RECORDS);
      let saved: DemoRecord | undefined;
      const req = records.get(id) as IDBRequest<DemoRecord | undefined>;
      req.onsuccess = () => {
        const record = req.result;
        if (!record || change(record) === false) return;
        records.put(record);
        saved = record;
      };
      await completion(tx);
      return saved;
    },
    delete: async (id) => {
      await run(RECORDS, 'readwrite', (s) => s.delete(id));
    },
    getAudio: (id) => run(AUDIO, 'readonly', (s) => s.get(id) as IDBRequest<Blob | undefined>),
    putAudio: async (id, audio) => {
      await run(AUDIO, 'readwrite', (s) => s.put(audio, id));
    },
    deleteAudio: async (id) => {
      await run(AUDIO, 'readwrite', (s) => s.delete(id));
    },
  };
}

function memoryStore(): DemoStore {
  const records = new Map<string, DemoRecord>();
  const audio = new Map<string, Blob>();
  return {
    all: async () => [...records.values()].map((r) => structuredClone(r)),
    get: async (id) => {
      const r = records.get(id);
      return r ? structuredClone(r) : undefined;
    },
    put: async (record) => {
      records.set(record.id, structuredClone(record));
    },
    update: async (id, change) => {
      const stored = records.get(id);
      if (!stored) return undefined;
      const record = structuredClone(stored);
      if (change(record) === false) return undefined;
      records.set(id, structuredClone(record));
      return record;
    },
    delete: async (id) => {
      records.delete(id);
    },
    getAudio: async (id) => audio.get(id),
    putAudio: async (id, blob) => {
      audio.set(id, blob);
    },
    deleteAudio: async (id) => {
      audio.delete(id);
    },
  };
}

let storePromise: Promise<DemoStore> | null = null;

export function getDemoStore(): Promise<DemoStore> {
  storePromise ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
      return indexedDbStore(await openIndexedDb());
    } catch {
      return memoryStore();
    }
  })();
  return storePromise;
}
