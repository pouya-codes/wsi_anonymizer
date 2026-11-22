/**
 * Client-side path anonymization (original name → slide-NNNN).
 *
 * Replaces patient-identifying path stems with ``slide-NNNN`` while preserving
 * companion-folder layouts for multi-file formats (MRXS, VSI, DICOM series).
 * File bytes are unchanged — label/metadata scrubbing is done separately by
 * EMPAIA WSI-anon (see wsiAnon.ts).
 */
import type { LocalFile, LocalFileset } from '@/types';
import { extensionOf } from './filesets';

export interface AnonymizeResult {
  files: LocalFile[];
  /** Original main path → anonymized main path, for the queue UI. */
  mapping: Record<string, string>;
  /** Every renamed path (original → new), for export / review. */
  fileMapping: Record<string, string>;
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '' : path.slice(0, slash);
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

export interface AnonymizeNamesOptions {
  /** First slide number (default 1), e.g. to continue an existing output folder. */
  startAt?: number;
  /**
   * Drop the folders the slide was selected from, so `Patient_Smith/a.svs`
   * becomes `slide-0001.svs` rather than `Patient_Smith/slide-0001.svs`.
   * Companion folders (MRXS `slide-0001/`, VSI `_slide-0001_/`) are kept.
   */
  dropParentDirs?: boolean;
}

/** Parse the number out of a `slide-NNNN` stem, or null if it is not one. */
export function slideNumberOf(name: string): number | null {
  const m = /^slide-(\d+)(?:\.|$)/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * Build anonymized relative paths for every file in the given filesets.
 * Paths outside any fileset are left unchanged (they should already be skipped).
 */
export function anonymizeLocalFiles(
  files: LocalFile[],
  filesets: LocalFileset[],
  options: AnonymizeNamesOptions = {}
): AnonymizeResult {
  const rename = new Map<string, string>();
  const mapping: Record<string, string> = {};
  const startAt = Math.max(1, Math.floor(options.startAt ?? 1));

  filesets.forEach((fs, i) => {
    const id = `slide-${pad(i + startAt)}`;
    const ext = extensionOf(fs.main);
    const parent = options.dropParentDirs ? '' : dirnameOf(fs.main);
    const srcParent = dirnameOf(fs.main);
    const oldStem = stemOf(fs.main);
    const anonMain = parent ? `${parent}/${id}${ext}` : `${id}${ext}`;
    mapping[fs.main] = anonMain;

    if (ext === '.mrxs') {
      const oldDir = srcParent ? `${srcParent}/${oldStem}` : oldStem;
      const newDir = parent ? `${parent}/${id}` : id;
      rename.set(fs.main, anonMain);
      for (const member of fs.files) {
        if (member.path === fs.main) continue;
        if (member.path === oldDir || member.path.startsWith(`${oldDir}/`)) {
          rename.set(member.path, newDir + member.path.slice(oldDir.length));
        } else {
          rename.set(member.path, member.path);
        }
      }
      return;
    }

    if (ext === '.vsi') {
      const oldDir = srcParent ? `${srcParent}/_${oldStem}_` : `_${oldStem}_`;
      const newDir = parent ? `${parent}/_${id}_` : `_${id}_`;
      rename.set(fs.main, anonMain);
      for (const member of fs.files) {
        if (member.path === fs.main) continue;
        if (member.path === oldDir || member.path.startsWith(`${oldDir}/`)) {
          rename.set(member.path, newDir + member.path.slice(oldDir.length));
        } else {
          rename.set(member.path, member.path);
        }
      }
      return;
    }

    if (ext === '.dcm') {
      // Keep series folder; rename each DICOM file under an anonymous series dir.
      const seriesDir = parent ? `${parent}/${id}` : id;
      for (const member of fs.files) {
        const base = member.path.slice(member.path.lastIndexOf('/') + 1);
        rename.set(member.path, `${seriesDir}/${base}`);
      }
      mapping[fs.main] = rename.get(fs.main) ?? anonMain;
      return;
    }

    // Single-file WSI.
    rename.set(fs.main, anonMain);
    for (const member of fs.files) {
      if (member.path !== fs.main) rename.set(member.path, member.path);
    }
  });

  const filesOut = files.map((f) => ({
    ...f,
    path: rename.get(f.path) ?? f.path,
  }));

  const fileMapping: Record<string, string> = {};
  for (const [from, to] of rename) {
    if (from !== to) fileMapping[from] = to;
  }
  // Ensure main slides appear even if a format left them only in `mapping`.
  for (const [from, to] of Object.entries(mapping)) {
    if (from !== to) fileMapping[from] = to;
  }

  return { files: filesOut, mapping, fileMapping };
}
