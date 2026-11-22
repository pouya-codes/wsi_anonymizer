/**
 * Browser WASM wrapper around EMPAIA @empaia/wsi-anon.
 *
 * Scrubs label/macro associated images and identifying metadata in-browser.
 * File size stays the same; changes are applied
 * as overlays when reading chunks (so multi-GB slides need not be fully copied).
 *
 * @see https://gitlab.com/empaia/integration/wsi-anon
 */
import type { LocalFileset } from '@/types';
import { extensionOf } from './filesets';

/** Formats EMPAIA WSI-anon documents as supported. */
export const WASM_ANON_EXTENSIONS = new Set([
  '.svs',
  '.tif',
  '.tiff',
  '.ndpi',
  '.mrxs',
  '.bif',
  '.isyntax',
]);

export function isWasmAnonSupported(path: string): boolean {
  return WASM_ANON_EXTENSIONS.has(extensionOf(path));
}

export interface AnonymizedChunkSource {
  path: string;
  size: number;
  getChunk: (offset: number, size: number) => Promise<Blob>;
  destroy: () => void;
}

/** Bytes to overwrite in place in a file (same length, file size unchanged). */
export interface ByteEdit {
  offset: number;
  bytes: Uint8Array;
}

/** Overlay in-place byte edits on top of a chunk source. */
export function withByteEdits(src: AnonymizedChunkSource, edits: ByteEdit[]): AnonymizedChunkSource {
  if (!edits.length) return src;
  return {
    ...src,
    getChunk: async (offset, size) => {
      const blob = await src.getChunk(offset, size);
      const end = offset + blob.size;
      const touching = edits.filter((e) => e.offset < end && e.offset + e.bytes.length > offset);
      if (!touching.length) return blob;
      const buf = new Uint8Array(await blob.arrayBuffer());
      for (const e of touching) {
        const from = Math.max(e.offset, offset);
        const to = Math.min(e.offset + e.bytes.length, end);
        buf.set(e.bytes.subarray(from - e.offset, to - e.offset), from - offset);
      }
      return new Blob([buf]);
    },
  };
}

/** The original file, unchanged (edits are added with withByteEdits). */
export function plainSource(path: string, file: File): AnonymizedChunkSource {
  return {
    path,
    size: file.size,
    getChunk: async (offset, size) => file.slice(offset, offset + size),
    destroy: () => {},
  };
}

export interface WasmAnonProgress {
  filesetIndex: number;
  filesetName: string;
  current: number;
  total: number;
}

export interface WasmAnonResult {
  /** Relative path → chunk reader with scrubbed bytes. */
  byPath: Record<string, AnonymizedChunkSource>;
  version: string;
  scrubbedFilesets: number;
}

type AnonymizedStreamCtor = {
  create: (file: File, chunkSize: number, path: string) => AnonymizedStreamInstance;
  ready: Promise<void>;
  VERSION?: string;
  destroy: (path: string) => void;
  retrieve: (path: string) => AnonymizedStreamInstance;
  exists: (path: string) => boolean;
};

type AnonymizedStreamInstance = {
  size: number;
  anonymize: () => Promise<void>;
  getAnonymizedChunk: (offset: number, size: number) => Promise<ArrayBuffer>;
};

const DEFAULT_CHUNK = 10 * 1000 * 1000; // 10 MB, matches EMPAIA docs

let loadPromise: Promise<AnonymizedStreamCtor> | null = null;

async function loadLibrary(): Promise<AnonymizedStreamCtor> {
  if (!loadPromise) {
    loadPromise = import('@empaia/wsi-anon').then(async (mod) => {
      const AnonymizedStream = (mod.default ?? mod) as AnonymizedStreamCtor;
      if (!AnonymizedStream?.create) {
        throw new Error('WSI-anon WASM module did not export AnonymizedStream');
      }
      await AnonymizedStream.ready;
      return AnonymizedStream;
    });
  }
  return loadPromise;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Load the WASM runtime once and return the tool version string. */
export async function wsiAnonVersion(): Promise<string> {
  const AnonymizedStream = await loadLibrary();
  return AnonymizedStream.VERSION ?? '0.4.32';
}

export interface AnonymizeFilesetOptions {
  /**
   * Prefix for the keys registered in the WASM file registry. The registry is
   * global, so independent callers namespace their keys to avoid clobbering
   * each other's sources.
   * Acts like an extra parent directory, so companion lookups still resolve.
   */
  keyPrefix?: string;
}

/**
 * Register every file of one fileset, run anonymize on the main slide, and
 * return chunk readers keyed by the fileset's (unprefixed) relative paths.
 * Companion files (MRXS etc.) must be registered before anonymize.
 */
export async function anonymizeFilesetWasm(
  fs: LocalFileset,
  options: AnonymizeFilesetOptions = {}
): Promise<Record<string, AnonymizedChunkSource>> {
  const AnonymizedStream = await loadLibrary();
  const prefix = options.keyPrefix ?? '';
  const keyOf = (path: string) => `${prefix}${path}`;

  if (!isWasmAnonSupported(fs.main)) {
    throw new Error(`Browser anonymizer does not support ${basename(fs.main)}`);
  }

  // Register all members first (required for multi-file formats).
  for (const member of fs.files) {
    const key = keyOf(member.path);
    if (AnonymizedStream.exists(key)) AnonymizedStream.destroy(key);
    AnonymizedStream.create(member.file, DEFAULT_CHUNK, key);
  }

  try {
    await AnonymizedStream.retrieve(keyOf(fs.main)).anonymize();
  } catch (err) {
    // Clean up registrations on failure.
    for (const member of fs.files) {
      const key = keyOf(member.path);
      if (AnonymizedStream.exists(key)) AnonymizedStream.destroy(key);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Anonymization failed for ${basename(fs.main)}: ${detail}`);
  }

  const byPath: Record<string, AnonymizedChunkSource> = {};
  for (const member of fs.files) {
    const key = keyOf(member.path);
    const stream = AnonymizedStream.retrieve(key);
    byPath[member.path] = {
      path: member.path,
      size: stream.size,
      getChunk: async (offset, size) => {
        const buf = await stream.getAnonymizedChunk(offset, size);
        return new Blob([new Uint8Array(buf)]);
      },
      destroy: () => {
        if (AnonymizedStream.exists(key)) AnonymizedStream.destroy(key);
      },
    };
  }
  return byPath;
}

/**
 * Anonymize every fileset (all-or-nothing) and return chunk readers for all
 * members (all-or-nothing batch variant).
 */
export async function anonymizeFilesetsWasm(
  filesets: LocalFileset[],
  onProgress?: (p: WasmAnonProgress) => void
): Promise<WasmAnonResult> {
  const unsupported = filesets.filter((fs) => !isWasmAnonSupported(fs.main)).map((fs) => fs.main);
  if (unsupported.length) {
    throw new Error(
      `Browser anonymizer does not support: ${unsupported
        .map(basename)
        .slice(0, 5)
        .join(', ')}${unsupported.length > 5 ? '…' : ''}. ` +
        'Scrub with an external tool, or turn off WASM scrub and attest manually.'
    );
  }

  const byPath: Record<string, AnonymizedChunkSource> = {};
  let done = 0;
  for (const fs of filesets) {
    onProgress?.({
      filesetIndex: fs.index,
      filesetName: basename(fs.main),
      current: done,
      total: filesets.length,
    });
    Object.assign(byPath, await anonymizeFilesetWasm(fs));
    done += 1;
    onProgress?.({
      filesetIndex: fs.index,
      filesetName: basename(fs.main),
      current: done,
      total: filesets.length,
    });
  }

  return {
    byPath,
    version: await wsiAnonVersion(),
    scrubbedFilesets: filesets.length,
  };
}

export function destroyAnonSources(sources: Record<string, AnonymizedChunkSource>): void {
  for (const src of Object.values(sources)) {
    try {
      src.destroy();
    } catch {
      /* ignore */
    }
  }
}
