/**
 * anonymization-mapping.csv — the record kept at the root of an output folder.
 *
 * One row per anonymized slide: original → anonymized name, where its original
 * label / macro images were saved, and (filled in by "Read labels") the label
 * text. It is both the user's deliverable (opens in Excel) and the save file
 * that lets label reading be resumed later.
 *
 * Every write is read-merge-write under one lock, so an anonymization run and
 * the label reader working on the same folder never overwrite each other, and
 * edits made in Excel between saves (extra columns, other rows) are kept.
 */
import { readTextFile, writeTextFile } from './localSave';
import { parseCsv, toCsv } from '@/utils/csv';

export const MAPPING_CSV_NAME = 'anonymization-mapping.csv';
const MAPPING_CSV_RE = /^anonymization-mapping(?:-(\d+))?\.csv$/;

export const MAPPING_COLUMNS = [
  'original_path',
  'anonymized_path',
  'original_filename',
  'anonymized_filename',
  'label_files',
  'macro_files',
  'anonymized_at',
  'wsi_anon_version',
  'label_text',
  /** '' (not read) | 'ocr' (machine read, unchecked) | 'edited' | 'reviewed' */
  'label_status',
  'label_ocr_confidence',
  /** Degrees clockwise to show the label upright (labels are often stored sideways). */
  'label_rotation',
] as const;

export type MappingRecord = Record<string, string>;

export interface MappingTable {
  path: string;
  columns: string[];
  records: MappingRecord[];
}

/** Rows written by this app always have these; anything else is not ours. */
const KEY_COLUMNS = ['original_path', 'anonymized_path'];

export function parseMappingTable(path: string, text: string): MappingTable | null {
  const rows = parseCsv(text);
  if (!rows.length) return { path, columns: [...MAPPING_COLUMNS], records: [] };
  const header = rows[0].map((h) => h.trim());
  if (!KEY_COLUMNS.every((k) => header.includes(k))) return null;
  // Our columns first (older files lack the label columns), then any the user added.
  const columns = [...MAPPING_COLUMNS, ...header.filter((h) => h && !MAPPING_COLUMNS.includes(h as never))];
  const records = rows.slice(1).map((r) => {
    const rec: MappingRecord = {};
    header.forEach((h, i) => {
      if (h) rec[h] = r[i] ?? '';
    });
    return rec;
  });
  return { path, columns, records };
}

export function serializeMappingTable(table: MappingTable): string {
  return toCsv([
    table.columns,
    ...table.records.map((rec) => table.columns.map((c) => rec[c] ?? '')),
  ]);
}

/* ----------------------------------- Lock ---------------------------------- */

let queue: Promise<unknown> = Promise.resolve();

/** Run CSV read-modify-write steps one at a time (all writers are in this tab). */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/* --------------------------------- Folder IO ------------------------------- */

/** Mapping CSVs at the root of `dir`, main file first. */
export async function listMappingCsvs(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const found: { name: string; n: number }[] = [];
  for await (const [name, handle] of dir.entries()) {
    const m = MAPPING_CSV_RE.exec(name);
    if (m && handle.kind === 'file') found.push({ name, n: m[1] ? Number(m[1]) : 1 });
  }
  return found.sort((a, b) => a.n - b.n).map((f) => f.name);
}

export async function readMappingTable(
  dir: FileSystemDirectoryHandle,
  path: string
): Promise<MappingTable> {
  const text = await readTextFile(dir, path);
  if (text == null) throw new Error(`${path} was not found in this folder`);
  const table = parseMappingTable(path, text);
  if (!table) {
    throw new Error(`${path} does not look like a mapping file (no original_path / anonymized_path columns)`);
  }
  return table;
}

/**
 * The mapping file an anonymization run should append to: the main one, unless
 * a file of that name exists that is not ours, then the first free numbered one.
 */
export async function mappingCsvForAppend(dir: FileSystemDirectoryHandle): Promise<string> {
  const stem = MAPPING_CSV_NAME.replace(/\.csv$/, '');
  for (let n = 1; n < 1000; n += 1) {
    const path = n === 1 ? MAPPING_CSV_NAME : `${stem}-${n}.csv`;
    const text = await readTextFile(dir, path);
    if (text == null || !text.trim() || parseMappingTable(path, text)) return path;
  }
  throw new Error('Too many mapping files in the output folder');
}

/** Append one slide's row (or replace the row for the same anonymized path). */
export function appendMappingRecord(
  dir: FileSystemDirectoryHandle,
  path: string,
  record: MappingRecord
): Promise<void> {
  return withLock(async () => {
    const text = await readTextFile(dir, path);
    const table = text?.trim()
      ? parseMappingTable(path, text)
      : { path, columns: [...MAPPING_COLUMNS], records: [] };
    if (!table) throw new Error(`${path} was replaced by a file that is not a mapping file`);
    const at = table.records.findIndex((r) => r.anonymized_path === record.anonymized_path);
    if (at >= 0) table.records[at] = { ...table.records[at], ...record };
    else table.records.push(record);
    await writeTextFile(dir, path, serializeMappingTable(table), 'text/csv');
  });
}

/**
 * Write the given fields into the rows with matching anonymized_path, keeping
 * every other row and column as it is on disk now. Returns the merged table.
 */
export function updateMappingRecords(
  dir: FileSystemDirectoryHandle,
  path: string,
  updates: Map<string, MappingRecord>
): Promise<MappingTable> {
  return withLock(async () => {
    const table = await readMappingTable(dir, path);
    const missing = new Set(updates.keys());
    for (const rec of table.records) {
      const patch = updates.get(rec.anonymized_path);
      if (patch) {
        Object.assign(rec, patch);
        missing.delete(rec.anonymized_path);
      }
    }
    if (missing.size) {
      throw new Error(
        `${missing.size} slide(s) are no longer listed in ${path} (was the file edited?)`
      );
    }
    await writeTextFile(dir, path, serializeMappingTable(table), 'text/csv');
    return table;
  });
}

/** Every anonymized path listed in the folder's mapping files. */
export async function listedAnonymizedPaths(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for (const path of await listMappingCsvs(dir)) {
    const text = await readTextFile(dir, path);
    const table = text ? parseMappingTable(path, text) : null;
    for (const rec of table?.records ?? []) if (rec.anonymized_path) out.push(rec.anonymized_path);
  }
  return out;
}
