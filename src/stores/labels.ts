/**
 * Step 2 — read the original label images saved by step 1 and record their
 * text next to each slide in the folder's anonymization-mapping.csv.
 *
 * The CSV is the save file: open the same output folder later and the list
 * comes back with the text and review state as they were last saved. OCR
 * (labelOcr.ts) only pre-fills empty, unreviewed labels; the user checks it.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { readLabel, terminateOcr, warmUpOcr } from '@/ocr/labelOcr';
import { ensureWritePermission, getFile, pickOutputDirectory } from '@/upload/localSave';
import {
  listMappingCsvs,
  readMappingTable,
  updateMappingRecords,
  type MappingRecord,
} from '@/upload/mappingCsv';
import { basename } from '@/utils/mappingExport';

export type LabelStatus = '' | 'ocr' | 'edited' | 'reviewed';
export type OcrState = 'idle' | 'queued' | 'running' | 'failed';
export type LabelFilter = 'all' | 'todo' | 'reviewed';

export interface LabelImage {
  path: string;
  /** Kept for OCR (the CSP does not allow fetch() of blob: URLs). */
  file: File | null;
  url: string | null;
  error: string | null;
}

export interface LabelRow {
  /** anonymized_path — the row key in the CSV. */
  key: string;
  anonymizedName: string;
  originalName: string;
  images: LabelImage[];
  text: string;
  status: LabelStatus;
  confidence: number | null;
  /** Display rotation (degrees clockwise); set from OCR, user can turn it. */
  rotation: number;
  ocr: OcrState;
  ocrError: string | null;
}

/** A slide that has no label image at all (label_status `none` in the CSV). */
export interface NoLabelRow {
  key: string;
  anonymizedName: string;
  originalName: string;
}

/** The fields of a row that are saved to the CSV. */
function savedFields(row: LabelRow): MappingRecord {
  return {
    label_text: row.text,
    label_status: row.status,
    label_ocr_confidence: row.confidence == null ? '' : String(row.confidence),
    label_rotation: row.rotation ? String(row.rotation) : '',
  };
}

const STATUSES: LabelStatus[] = ['', 'ocr', 'edited', 'reviewed'];

export const useLabelsStore = defineStore('labels', () => {
  const dir = shallowRef<FileSystemDirectoryHandle | null>(null);
  const csvPath = ref<string | null>(null);
  const csvChoices = ref<string[]>([]);
  const rows = ref<LabelRow[]>([]);
  /** Slides whose label_status is `none`: shown as "No label found in this slide". */
  const noLabelRows = ref<NoLabelRow[]>([]);
  /** Slides in the CSV that have no saved label image. */
  const withoutLabel = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const filter = ref<LabelFilter>('all');

  /** Row key → saved-field snapshot as last written to / read from disk. */
  const savedState = ref<Record<string, string>>({});
  const saving = ref(false);
  const savedAt = ref<string | null>(null);
  const saveError = ref<string | null>(null);

  const ocrRunning = ref(false);
  const ocrDone = ref(0);
  const ocrTotal = ref(0);
  const ocrMessage = ref<string | null>(null);
  let ocrAbort: AbortController | null = null;

  const snapshot = (row: LabelRow) => JSON.stringify(savedFields(row));

  const unsavedKeys = computed(() =>
    rows.value.filter((r) => savedState.value[r.key] !== snapshot(r)).map((r) => r.key)
  );
  const dirty = computed(() => unsavedKeys.value.length > 0);
  const reviewedCount = computed(() => rows.value.filter((r) => r.status === 'reviewed').length);
  const withTextCount = computed(() => rows.value.filter((r) => r.text.trim()).length);
  /** Labels OCR would read now: unreviewed, no text yet, an image the browser can open. */
  const unreadRows = computed(() =>
    rows.value.filter(
      (r) => r.status !== 'reviewed' && !r.text.trim() && r.images.some((i) => i.url)
    )
  );
  const visibleRows = computed(() => {
    if (filter.value === 'todo') return rows.value.filter((r) => r.status !== 'reviewed');
    if (filter.value === 'reviewed') return rows.value.filter((r) => r.status === 'reviewed');
    return rows.value;
  });

  function rowOf(key: string): LabelRow | undefined {
    return rows.value.find((r) => r.key === key);
  }

  function revokeImages(): void {
    for (const row of rows.value) {
      for (const img of row.images) if (img.url) URL.revokeObjectURL(img.url);
    }
  }

  /* ------------------------------- Loading -------------------------------- */

  async function buildRows(
    folder: FileSystemDirectoryHandle,
    records: MappingRecord[]
  ): Promise<LabelRow[]> {
    const byKey = new Map<string, MappingRecord>();
    for (const rec of records) if (rec.anonymized_path) byKey.set(rec.anonymized_path, rec);
    const out: LabelRow[] = [];
    const none: NoLabelRow[] = [];
    let missing = 0;
    for (const [key, rec] of byKey) {
      const paths = (rec.label_files ?? '').split(';').map((p) => p.trim()).filter(Boolean);
      if (!paths.length) {
        if (rec.label_status === 'none') {
          none.push({
            key,
            anonymizedName: rec.anonymized_filename || basename(key),
            originalName: rec.original_filename || basename(rec.original_path ?? ''),
          });
        } else {
          missing += 1;
        }
        continue;
      }
      const images: LabelImage[] = [];
      for (const path of paths) {
        try {
          const file = await getFile(folder, path);
          images.push(
            file
              ? { path, file, url: URL.createObjectURL(file), error: null }
              : { path, file: null, url: null, error: 'File not found' }
          );
        } catch (err) {
          images.push({
            path,
            file: null,
            url: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const status = STATUSES.includes(rec.label_status as LabelStatus)
        ? (rec.label_status as LabelStatus)
        : rec.label_text
          ? 'edited'
          : '';
      const conf = Number.parseFloat(rec.label_ocr_confidence ?? '');
      const rot = Number.parseInt(rec.label_rotation ?? '', 10);
      out.push({
        key,
        anonymizedName: rec.anonymized_filename || basename(key),
        originalName: rec.original_filename || basename(rec.original_path ?? ''),
        images,
        text: rec.label_text ?? '',
        status,
        confidence: Number.isFinite(conf) ? conf : null,
        rotation: [90, 180, 270].includes(rot) ? rot : 0,
        ocr: 'idle',
        ocrError: null,
      });
    }
    withoutLabel.value = missing;
    noLabelRows.value = none;
    return out;
  }

  /**
   * (Re)load the list from the CSV. Unsaved edits and display rotations of
   * rows that are still listed are kept, so a reload after a new anonymization
   * run only adds the new slides.
   */
  async function loadCsv(path: string): Promise<void> {
    const folder = dir.value;
    if (!folder) return;
    loading.value = true;
    error.value = null;
    try {
      const table = await readMappingTable(folder, path);
      const fresh = await buildRows(folder, table.records);
      const keep = path === csvPath.value ? rows.value : [];
      const unsaved = new Set(path === csvPath.value ? unsavedKeys.value : []);
      const nextSaved: Record<string, string> = {};
      for (const row of fresh) {
        nextSaved[row.key] = snapshot(row);
        const old = keep.find((r) => r.key === row.key);
        if (!old || !unsaved.has(row.key)) continue;
        row.text = old.text;
        row.status = old.status;
        row.confidence = old.confidence;
        row.rotation = old.rotation;
      }
      revokeImages();
      rows.value = fresh;
      savedState.value = nextSaved;
      csvPath.value = path;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function useFolder(folder: FileSystemDirectoryHandle): Promise<void> {
    if (ocrRunning.value) return;
    if (!(await ensureWritePermission(folder))) {
      error.value = 'Write permission to the folder was not granted.';
      return;
    }
    error.value = null;
    saveError.value = null;
    savedAt.value = null;
    revokeImages();
    rows.value = [];
    noLabelRows.value = [];
    savedState.value = {};
    csvPath.value = null;
    dir.value = folder;
    csvChoices.value = await listMappingCsvs(folder);
    if (!csvChoices.value.length) {
      error.value =
        'No anonymization-mapping.csv in this folder. Choose the output folder of step 1 (Anonymize slides).';
      return;
    }
    await loadCsv(csvChoices.value[0]);
  }

  /** Returns false if the user dismissed the picker. */
  async function openFolder(): Promise<boolean> {
    let folder: FileSystemDirectoryHandle;
    try {
      folder = await pickOutputDirectory();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      throw err;
    }
    await useFolder(folder);
    return true;
  }

  async function isCurrentFolder(folder: FileSystemDirectoryHandle | null): Promise<boolean> {
    return !!folder && !!dir.value && (await dir.value.isSameEntry(folder));
  }

  /** Pick up slides added to the open folder by a new anonymization run. */
  async function refreshIfShowing(folder: FileSystemDirectoryHandle | null): Promise<void> {
    if (ocrRunning.value || !csvPath.value || !(await isCurrentFolder(folder))) return;
    csvChoices.value = await listMappingCsvs(dir.value!);
    await loadCsv(csvPath.value);
  }

  function close(): void {
    if (ocrRunning.value) return;
    revokeImages();
    rows.value = [];
    noLabelRows.value = [];
    savedState.value = {};
    dir.value = null;
    csvPath.value = null;
    csvChoices.value = [];
    error.value = null;
    saveError.value = null;
    savedAt.value = null;
  }

  /* -------------------------------- Edits --------------------------------- */

  function setText(key: string, text: string): void {
    const row = rowOf(key);
    if (!row || row.text === text) return;
    row.text = text;
    if (row.status !== 'reviewed') row.status = 'edited';
  }

  function setReviewed(key: string, reviewed: boolean): void {
    const row = rowOf(key);
    if (!row) return;
    row.status = reviewed ? 'reviewed' : row.text.trim() ? 'edited' : '';
  }

  function rotate(key: string, by = 90): void {
    const row = rowOf(key);
    if (row) row.rotation = (row.rotation + by + 360) % 360;
  }

  /* --------------------------------- Save --------------------------------- */

  async function save(): Promise<boolean> {
    const folder = dir.value;
    const path = csvPath.value;
    if (!folder || !path || saving.value) return false;
    const keys = unsavedKeys.value;
    if (!keys.length) return true;
    saving.value = true;
    saveError.value = null;
    // Snapshot now: edits typed while the file is being written stay unsaved.
    const updates = new Map<string, MappingRecord>();
    const snaps: Record<string, string> = {};
    for (const key of keys) {
      const row = rowOf(key)!;
      updates.set(key, savedFields(row));
      snaps[key] = snapshot(row);
    }
    try {
      if (!(await ensureWritePermission(folder))) {
        throw new Error('Write permission to the folder was not granted.');
      }
      await updateMappingRecords(folder, path, updates);
      savedState.value = { ...savedState.value, ...snaps };
      savedAt.value = new Date().toISOString();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      saveError.value = /NoModificationAllowed|InvalidState|locked/i.test(msg)
        ? `${msg} — is ${path} open in Excel? Close it and save again.`
        : msg;
      return false;
    } finally {
      saving.value = false;
    }
  }

  /* ---------------------------------- OCR --------------------------------- */

  /**
   * Read labels with OCR. Default: every unreviewed label without text. Fills
   * in text marked 'ocr' for the user to check, then saves.
   */
  async function runOcr(keys?: string[]): Promise<void> {
    if (ocrRunning.value) return;
    const targets = (keys ?? unreadRows.value.map((r) => r.key))
      .map(rowOf)
      .filter((r): r is LabelRow => !!r && r.images.some((i) => i.url));
    if (!targets.length) return;

    ocrRunning.value = true;
    ocrAbort = new AbortController();
    const signal = ocrAbort.signal;
    ocrDone.value = 0;
    ocrTotal.value = targets.length;
    for (const row of targets) {
      row.ocr = 'queued';
      row.ocrError = null;
    }
    let read = 0;
    try {
      ocrMessage.value = 'Loading the OCR engine…';
      await warmUpOcr();
      for (const row of targets) {
        if (signal.aborted) break;
        ocrMessage.value = `Reading ${row.anonymizedName} (${ocrDone.value + 1}/${targets.length})`;
        row.ocr = 'running';
        try {
          const parts: string[] = [];
          let conf = 0;
          let n = 0;
          for (const img of row.images) {
            if (!img.file) continue;
            const r = await readLabel(img.file, signal);
            if (r.text) parts.push(r.text);
            conf += r.confidence;
            n += 1;
            if (n === 1) row.rotation = r.rotation;
          }
          // The user may have typed while this label was being read.
          if (row.status !== 'reviewed' && row.status !== 'edited') {
            row.text = parts.join('\n');
            row.status = 'ocr';
            row.confidence = n ? Math.round(conf / n) : null;
          } else if (!row.text.trim()) {
            row.text = parts.join('\n');
          }
          row.ocr = 'idle';
          read += 1;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            row.ocr = 'idle';
            break;
          }
          row.ocr = 'failed';
          row.ocrError = err instanceof Error ? err.message : String(err);
        }
        ocrDone.value += 1;
      }
    } catch (err) {
      error.value = `OCR could not start: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      for (const row of targets) if (row.ocr === 'queued' || row.ocr === 'running') row.ocr = 'idle';
      ocrRunning.value = false;
      ocrAbort = null;
    }
    ocrMessage.value = signal.aborted
      ? `Stopped — read ${read} of ${targets.length} label(s).`
      : `Read ${read} of ${targets.length} label(s). Check each one and tick “Reviewed”.`;
    // OCR results are worth keeping even if the user forgets to save.
    if (read) await save();
  }

  function cancelOcr(): void {
    ocrAbort?.abort();
  }

  return {
    dir,
    csvPath,
    csvChoices,
    rows,
    noLabelRows,
    visibleRows,
    withoutLabel,
    loading,
    error,
    filter,
    saving,
    savedAt,
    saveError,
    unsavedKeys,
    dirty,
    reviewedCount,
    withTextCount,
    unreadRows,
    ocrRunning,
    ocrDone,
    ocrTotal,
    ocrMessage,
    openFolder,
    useFolder,
    loadCsv,
    refreshIfShowing,
    close,
    setText,
    setReviewed,
    rotate,
    save,
    runOcr,
    cancelOcr,
    terminateOcr,
  };
});
