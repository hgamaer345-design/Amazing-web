import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger';

const SAFE_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?(\.part)?$/;

/**
 * Stores uploaded audio on local disk under generated names (never the user's file name),
 * so a request can never read or write outside the uploads directory.
 */
export class AudioStorage {
  constructor(readonly dir: string) {}

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** A fresh, unused file name like "3f2c…e1.mp3". */
  newFileName(extension: string): string {
    const ext = extension.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    return ext ? `${randomUUID()}.${ext}` : randomUUID();
  }

  /** Absolute path for a stored file name. Throws if the name is not one we generated. */
  absPath(fileName: string): string {
    if (!SAFE_NAME.test(fileName)) throw new Error(`Unsafe storage file name: ${fileName}`);
    return path.join(this.dir, fileName);
  }

  async exists(fileName: string): Promise<boolean> {
    try {
      await fsp.access(this.absPath(fileName));
      return true;
    } catch {
      return false;
    }
  }

  async size(fileName: string): Promise<number | null> {
    try {
      return (await fsp.stat(this.absPath(fileName))).size;
    } catch {
      return null;
    }
  }

  /** Deletes a stored file; succeeds silently if it is already gone. */
  async delete(fileName: string): Promise<void> {
    try {
      await fsp.unlink(this.absPath(fileName));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Removes files no transcript references (left behind by crashes or aborted uploads).
   * In-progress uploads ("*.part") younger than `partMaxAgeMs` are left alone.
   */
  async cleanupOrphans(referenced: Set<string>, partMaxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const name of entries) {
      if (referenced.has(name) || !SAFE_NAME.test(name)) continue;
      try {
        if (name.endsWith('.part')) {
          const stat = await fsp.stat(this.absPath(name));
          if (now - stat.mtimeMs < partMaxAgeMs) continue;
        }
        await this.delete(name);
        removed++;
      } catch (err) {
        log.warn('Failed to remove orphaned upload', { file: name, err });
      }
    }
    if (removed) log.info('Removed orphaned uploads', { count: removed });
    return removed;
  }
}
