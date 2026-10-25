import type { TranscriptRecord, TranscriptRepository } from '../db';
import { AppError } from '../errors';
import { log } from '../logger';
import type { AudioStorage } from '../storage';

/** The transcript with this id, or a 404 NOT_FOUND. */
export function requireTranscript(repo: TranscriptRepository, id: string): TranscriptRecord {
  const rec = repo.get(id);
  if (!rec) throw new AppError('NOT_FOUND');
  return rec;
}

/**
 * Deletes a stored audio file whose record no longer references it. A failure is only logged:
 * the file is then an orphan that the startup cleanup removes.
 */
export async function deleteStoredAudio(storage: AudioStorage, fileName: string): Promise<void> {
  try {
    await storage.delete(fileName);
  } catch (err) {
    log.warn('Could not delete audio file', {
      file: fileName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
