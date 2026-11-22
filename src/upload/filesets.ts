/**
 * Client-side path sanitization and fileset grouping.
 *
 * Grouping rules mirror cPathPortal's import manifest
 * (`aimviewer/services/transfer_manifest.py`) so multi-file slides (MRXS,
 * VSI, DICOM series) are handled the same way here.
 */
import type { LocalFile, LocalFileset } from '@/types';

const MRXS = '.mrxs';
const VSI = '.vsi';
const DICOM = '.dcm';

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '' : path.slice(0, slash);
}

/** Normalize a browser-supplied relative path, or return null if unusable. */
export function sanitizeRelativePath(raw: string): string | null {
  const cleaned = (raw || '').trim().replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('\0') || cleaned.startsWith('/')) return null;
  const segments: string[] = [];
  for (const rawSegment of cleaned.split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue;
    if (rawSegment === '..') return null;
    const segment = rawSegment.replace(/[ .]+$/, '');
    if (!segment) return null;
    segments.push(segment);
  }
  return segments.length ? segments.join('/') : null;
}

/** Normalize an extension list to lowercase, dot-prefixed, last-component form. */
export function normalizeExtensions(extensions: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of extensions || []) {
    let ext = String(raw).trim().toLowerCase();
    if (!ext) continue;
    if (!ext.startsWith('.') ) ext = `.${ext}`;
    const parts = ext.split('.').filter(Boolean);
    out.add(`.${parts[parts.length - 1]}`);
  }
  return out;
}

/**
 * Group selected files into importable filesets.
 *
 * Rules: `X.mrxs` claims the sibling directory `X/`, `X.vsi` claims `_X_/`,
 * `.dcm` files in a directory form one series, and every other allowed
 * extension is a single-file fileset. Anything unclaimed is returned as
 * `skipped` so the UI can tell the user it will be ignored.
 */
export function groupFilesets(
  files: LocalFile[],
  allowedExtensions: string[]
): { filesets: LocalFileset[]; skipped: LocalFile[] } {
  const allowed = normalizeExtensions(allowedExtensions);
  const byPath = new Map<string, LocalFile>();
  for (const entry of files) byPath.set(entry.path, entry);

  const claimed = new Set<string>();
  const groups: { main: string; members: string[] }[] = [];
  const paths = [...byPath.keys()].sort();

  const companionsUnder = (directory: string): string[] => {
    const prefix = `${directory}/`;
    return paths.filter((p) => !claimed.has(p) && p.startsWith(prefix));
  };

  // Pass 1: directory-companion formats.
  for (const path of paths) {
    if (claimed.has(path)) continue;
    const ext = extensionOf(path);
    if (ext !== MRXS && ext !== VSI) continue;
    const parent = dirnameOf(path);
    const stem = stemOf(path);
    const sidecar = ext === MRXS ? stem : `_${stem}_`;
    const directory = parent ? `${parent}/${sidecar}` : sidecar;
    const members = [path, ...companionsUnder(directory).sort()];
    members.forEach((m) => claimed.add(m));
    groups.push({ main: path, members });
  }

  // Pass 2: DICOM series (one fileset per directory).
  const dicomDirs = new Map<string, string[]>();
  for (const path of paths) {
    if (claimed.has(path) || extensionOf(path) !== DICOM) continue;
    const dir = dirnameOf(path);
    dicomDirs.set(dir, [...(dicomDirs.get(dir) ?? []), path]);
  }
  for (const members of [...dicomDirs.values()]) {
    members.sort();
    members.forEach((m) => claimed.add(m));
    groups.push({ main: members[0], members });
  }

  // Pass 3: plain single-file formats.
  for (const path of paths) {
    if (claimed.has(path) || !allowed.has(extensionOf(path))) continue;
    claimed.add(path);
    groups.push({ main: path, members: [path] });
  }

  groups.sort((a, b) => (a.main < b.main ? -1 : a.main > b.main ? 1 : 0));

  const filesets: LocalFileset[] = groups.map((group, index) => {
    const members = group.members.map((p) => byPath.get(p) as LocalFile);
    return {
      index,
      main: group.main,
      files: members,
      size: members.reduce((sum, f) => sum + f.size, 0),
    };
  });

  const skipped = paths.filter((p) => !claimed.has(p)).map((p) => byPath.get(p) as LocalFile);
  return { filesets, skipped };
}

/**
 * Recursively walk a dropped directory entry, collecting files with paths
 * relative to the drop root (`DataTransferItem.webkitGetAsEntry`).
 */
export async function walkEntry(entry: FileSystemEntry, prefix = ''): Promise<LocalFile[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) =>
      fileEntry.file(resolve, reject)
    );
    const path = sanitizeRelativePath(prefix ? `${prefix}/${file.name}` : file.name);
    return path ? [{ path, size: file.size, file }] : [];
  }
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries() returns at most ~100 entries per call, so drain it.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) break;
    children.push(...batch);
  }
  const nested = await Promise.all(
    children.map((child) => walkEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name))
  );
  return nested.flat();
}

/** Collect files from a drop event, walking any dropped directories. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<LocalFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    const walked = await Promise.all(entries.map((entry) => walkEntry(entry)));
    return walked.flat();
  }
  // Browsers without the entries API: plain file list, no folder structure.
  return filesFromFileList(dt.files);
}

/** Collect files from an `<input type="file">`, preserving folder structure. */
export function filesFromFileList(list: FileList | null): LocalFile[] {
  const out: LocalFile[] = [];
  for (const file of Array.from(list ?? [])) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = sanitizeRelativePath(relative || file.name);
    if (path) out.push({ path, size: file.size, file });
  }
  return out;
}
