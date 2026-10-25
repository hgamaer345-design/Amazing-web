// Keeps the files uploaded in this browser session so the transcript page can play them
// back immediately (and even if the server deletes its copy after processing).
// Lost on page reload; the transcript page then falls back to the server copy, if kept,
// or lets the user attach the original file again.

const urls = new Map<string, string>();

export function setSessionAudio(transcriptId: string, file: Blob): string {
  const existing = urls.get(transcriptId);
  if (existing) URL.revokeObjectURL(existing);
  const url = URL.createObjectURL(file);
  urls.set(transcriptId, url);
  return url;
}

export function getSessionAudioUrl(transcriptId: string): string | null {
  return urls.get(transcriptId) ?? null;
}

export function clearSessionAudio(transcriptId: string): void {
  const url = urls.get(transcriptId);
  if (url) URL.revokeObjectURL(url);
  urls.delete(transcriptId);
}
