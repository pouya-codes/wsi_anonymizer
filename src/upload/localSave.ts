/**
 * Write anonymized slides to the user's own machine (no server involved).
 *
 * Preferred path: the File System Access API (`showDirectoryPicker`, Chromium
 * browsers). The user picks an output folder once and every scrubbed file is
 * streamed into it chunk by chunk, so multi-GB slides never sit in memory.
 * `createWritable()` writes to a swap file and only replaces the target on
 * `close()`, so a failed or cancelled write never leaves a half-written slide.
 *
 * Fallback (Firefox / Safari): each single-file slide is assembled into a Blob
 * and handed to the browser's normal download flow. Folder layouts (MRXS
 * companions) cannot be expressed as downloads, so those need Chromium.
 */
import { slideNumberOf } from './anonymizeNames';
import type { AnonymizedChunkSource } from './wsiAnon';
import { downloadBlob } from '@/utils/mappingExport';

/** Bytes read from the scrubbed stream per write. */
export const WRITE_CHUNK = 16 * 1024 * 1024;

/** Largest file the download fallback will buffer in memory. */
export const DOWNLOAD_FALLBACK_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickOutputDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser cannot write to a folder. Use Chrome or Edge.');
  }
  return window.showDirectoryPicker({ id: 'aim-anonymize-output', mode: 'readwrite' });
}

/** Make sure we still hold write access (it can lapse after a reload / idle). */
export async function ensureWritePermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  if (!dir.queryPermission) return true;
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!dir.requestPermission) return false;
  return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
}

function splitPath(relPath: string): { dirs: string[]; name: string } {
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid output path: ${relPath}`);
  return { dirs: parts, name };
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')
  );
}

async function resolveDir(
  root: FileSystemDirectoryHandle,
  dirs: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  for (const part of dirs) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (err) {
      if (!create && isNotFound(err)) return null;
      throw err;
    }
  }
  return dir;
}

/** True when a file (or folder) already exists at `relPath` under `root`. */
export async function pathExists(
  root: FileSystemDirectoryHandle,
  relPath: string
): Promise<boolean> {
  const { dirs, name } = splitPath(relPath);
  const dir = await resolveDir(root, dirs, false);
  if (!dir) return false;
  for (const probe of [
    () => dir.getFileHandle(name),
    () => dir.getDirectoryHandle(name),
  ]) {
    try {
      await probe();
      return true;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return false;
}

/**
 * First free `slide-NNNN` number across the given folders of `root`, so a
 * second run into the same output folder continues the sequence instead of
 * colliding with the first.
 */
export async function nextSlideNumber(
  root: FileSystemDirectoryHandle,
  relDirs: string[] = ['']
): Promise<number> {
  let max = 0;
  for (const rel of new Set(relDirs)) {
    const dir = await resolveDir(root, rel.split('/').filter(Boolean), false);
    if (!dir) continue;
    for await (const name of dir.keys()) {
      const n = slideNumberOf(name.replace(/^_(slide-\d+)_$/, '$1'));
      if (n != null && n > max) max = n;
    }
  }
  return max + 1;
}

export interface WriteOptions {
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

/** Stream one scrubbed file into `root/relPath`, creating folders as needed. */
export async function writeAnonymizedFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
  source: AnonymizedChunkSource,
  options: WriteOptions = {}
): Promise<void> {
  const { dirs, name } = splitPath(relPath);
  const dir = (await resolveDir(root, dirs, true)) as FileSystemDirectoryHandle;
  const existed = await pathExists(dir, name);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    for (let offset = 0; offset < source.size; offset += WRITE_CHUNK) {
      throwIfAborted(options.signal);
      const size = Math.min(WRITE_CHUNK, source.size - offset);
      await writable.write(await source.getChunk(offset, size));
      options.onBytes?.(size);
    }
    throwIfAborted(options.signal);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    // getFileHandle(create) leaves an empty file behind; drop it if it is ours.
    if (!existed) await dir.removeEntry(name).catch(() => undefined);
    throw err;
  }
}

/** Fallback: assemble a scrubbed file in memory and trigger a download. */
export async function downloadAnonymizedFile(
  filename: string,
  source: AnonymizedChunkSource,
  options: WriteOptions = {}
): Promise<void> {
  if (source.size > DOWNLOAD_FALLBACK_MAX_BYTES) {
    throw new Error(
      'File is too large to download from this browser. Use Chrome or Edge to save into a folder.'
    );
  }
  const parts: Blob[] = [];
  for (let offset = 0; offset < source.size; offset += WRITE_CHUNK) {
    throwIfAborted(options.signal);
    const size = Math.min(WRITE_CHUNK, source.size - offset);
    parts.push(await source.getChunk(offset, size));
    options.onBytes?.(size);
  }
  throwIfAborted(options.signal);
  downloadBlob(filename, new Blob(parts), 'application/octet-stream');
}

/** Wrap an in-memory Blob (e.g. an extracted label image) as a chunk source. */
export function blobSource(path: string, blob: Blob): AnonymizedChunkSource {
  return {
    path,
    size: blob.size,
    getChunk: async (offset, size) => blob.slice(offset, offset + size),
    destroy: () => undefined,
  };
}

/** Best-effort delete of a file written earlier in this run. */
export async function removePath(root: FileSystemDirectoryHandle, relPath: string): Promise<void> {
  const { dirs, name } = splitPath(relPath);
  const dir = await resolveDir(root, dirs, false);
  await dir?.removeEntry(name).catch(() => undefined);
}

/** The file at `root/relPath`, or null when there is no such file. */
export async function getFile(
  root: FileSystemDirectoryHandle,
  relPath: string
): Promise<File | null> {
  const { dirs, name } = splitPath(relPath);
  const dir = await resolveDir(root, dirs, false);
  if (!dir) return null;
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Text of `root/relPath`, or null when there is no such file. */
export async function readTextFile(
  root: FileSystemDirectoryHandle,
  relPath: string
): Promise<string | null> {
  const file = await getFile(root, relPath);
  return file ? file.text() : null;
}

/** Replace `root/relPath` with `text` (atomic: swap file until close). */
export async function writeTextFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
  text: string,
  mime = 'text/plain;charset=utf-8'
): Promise<void> {
  await writeAnonymizedFile(root, relPath, blobSource(relPath, new Blob([text], { type: mime })));
}
