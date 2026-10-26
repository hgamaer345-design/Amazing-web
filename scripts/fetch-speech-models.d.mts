// Types of fetch-speech-models.mjs, for the tests that import it.

export const SPEECH_MODELS_DIR: string;
export const MAX_PART_BYTES: number;

export interface ServedFile {
  file: string;
  bytes: number;
  sha256: string;
}

export interface ServedManifest {
  format: number;
  source: { url: string; member: string; sha256: string };
  model: ServedFile;
  data: ServedFile[];
  tokens: ServedFile;
}

export function toExternalData(
  model: Uint8Array,
  maxPartBytes: number,
  partName: (bytes: Uint8Array) => string,
): { graph: Uint8Array; parts: { name: string; bytes: Uint8Array }[] };

export function verifyExternalData(
  original: Uint8Array,
  graph: Uint8Array,
  parts: { name: string; bytes: Uint8Array }[],
): number;

export function writeServedModel(
  dir: string,
  modelBytes: Uint8Array,
  tokenBytes: Uint8Array,
  source: ServedManifest['source'],
): ServedManifest;

export function fetchSpeechModels(): Promise<string>;
