/**
 * Local-only anonymization: scrub slides on this computer and save the
 * anonymized copies into a folder the user picks. Nothing is uploaded; the app
 * makes no network requests with slide data.
 *
 * Same steps as the cPathPortal Transfer import's Anonymize stage
 * (aimviewer/frontend/transfer), from which this code was split out:
 *   1. EMPAIA WSI-anon WASM removes label / macro images and identifying
 *      metadata (`anonymizeFilesetWasm`, same as `anonymizeFilesetsWasm`).
 *   2. Optional filename sanitization to `slide-NNNN` (`anonymizeLocalFiles`).
 *
 * Slides are processed one at a time and released as soon as they are written,
 * so memory stays bounded for large batches. The original files are only read.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { anonymizeLocalFiles, slideNumberOf } from '@/upload/anonymizeNames';
import {
  extractAssociatedImages,
  NO_ASSOCIATED_NOTE,
  planMetadataScrub,
  supportsAssociatedExtraction,
  type AssociatedImage,
  type MetadataScrubPlan,
} from '@/upload/associatedImages';
import { extensionOf, groupFilesets } from '@/upload/filesets';
import { reportSlide } from '@/stores/session';
import {
  blobSource,
  downloadAnonymizedFile,
  ensureWritePermission,
  nextSlideNumber,
  pathExists,
  pickOutputDirectory,
  removePath,
  supportsDirectoryPicker,
  writeAnonymizedFile,
} from '@/upload/localSave';
import {
  anonymizeFilesetWasm,
  destroyAnonSources,
  isWasmAnonSupported,
  plainSource,
  WASM_ANON_EXTENSIONS,
  withByteEdits,
  wsiAnonVersion,
  type AnonymizedChunkSource,
} from '@/upload/wsiAnon';
import { basename } from '@/utils/mappingExport';
import {
  appendMappingRecord,
  listedAnonymizedPaths,
  mappingCsvForAppend,
} from '@/upload/mappingCsv';
import type { LocalFile, LocalFileset } from '@/types';

/** Namespaces our keys in the global WASM registry (see wsiAnon.ts). */
const WASM_KEY_PREFIX = 'local-anonymize/';

/** Subfolders of the output folder that receive the ORIGINAL label / macro images. */
export const LABELS_DIR = 'labels';
export const MACROS_DIR = 'macros';
const ASSOCIATED_EXTS = ['jpg', 'png', 'tif'];

function stripExtension(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(0, dot) : path;
}

/** `slide-0001.svs` → `labels/slide-0001_label` (extension added later). */
function associatedBase(outputMain: string, kind: AssociatedImage['kind']): string {
  const dir = kind === 'label' ? LABELS_DIR : MACROS_DIR;
  return `${dir}/${stripExtension(outputMain)}_${kind}`;
}

export type LocalAnonStatus =
  | 'queued'
  | 'unsupported'
  | 'extracting'
  | 'scrubbing'
  | 'writing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface LocalAnonRow {
  index: number;
  main: string;
  name: string;
  format: string;
  fileCount: number;
  size: number;
  /** Where the main file will be / was written, relative to the output folder. */
  outputPath: string | null;
  written: number;
  status: LocalAnonStatus;
  error: string | null;
  /** Original label / macro images saved for this slide (output-relative). */
  associated: string[];
  /** Why labels / macros could not (all) be saved. */
  notes: string[];
}

interface RunState {
  status: LocalAnonStatus;
  written: number;
  error: string | null;
  /** Output path of the main file, frozen when the slide starts processing. */
  outputPath: string | null;
  associated: string[];
  notes: string[];
}

export const useLocalAnonStore = defineStore('localAnon', () => {
  const files = ref<LocalFile[]>([]);

  /** Rewrite output names to slide-NNNN. */
  const sanitizeFilenames = ref(true);
  /** Drop the source folder names (they often carry patient / case IDs). */
  const dropParentDirs = ref(true);
  /** First slide-NNNN number; auto-advanced past what the output folder has. */
  const startAt = ref(1);
  /** Same attestations the cPathPortal import requires before anonymizing. */
  const residualRiskAck = ref(false);
  const filenameClean = ref(false);
  /** Save the original label / macro images into labels/ and macros/. */
  const saveAssociated = ref(true);

  const canPickFolder = supportsDirectoryPicker();
  const outputDir = shallowRef<FileSystemDirectoryHandle | null>(null);

  const running = ref(false);
  const message = ref<string | null>(null);
  const error = ref<string | null>(null);
  const toolVersion = ref<string | null>(null);
  /** Keyed by the slide's main path (fileset indices shift as files are added). */
  const runState = ref<Record<string, RunState>>({});
  /** original → anonymized relative path for every slide saved so far. */
  const lastMapping = ref<Record<string, string>>({});
  const lastRunAt = ref<string | null>(null);
  /** original main path → saved label / macro paths, for the mapping export. */
  const lastAssociated = ref<Record<string, string[]>>({});
  /** Mapping CSV written into the output folder by the last run. */
  const mappingCsvPath = ref<string | null>(null);
  /** Why the mapping CSV could not be written (slides are still saved). */
  const mappingCsvError = ref<string | null>(null);
  let abort: AbortController | null = null;

  /** Group with the WASM formats so MRXS companions are claimed correctly. */
  const grouped = computed(() => groupFilesets(files.value, [...WASM_ANON_EXTENSIONS]));
  const filesets = computed<LocalFileset[]>(() => grouped.value.filesets);
  const skipped = computed(() => grouped.value.skipped);
  const supported = computed(() => filesets.value.filter((fs) => isWasmAnonSupported(fs.main)));
  /** Supported slides not yet saved — the next run processes only these. */
  const pending = computed(() =>
    supported.value.filter((fs) => runState.value[fs.main]?.status !== 'done')
  );

  /** Planned output path for every member file of every pending slide. */
  const plan = computed(() => {
    const memberFiles = pending.value.flatMap((fs) => fs.files);
    if (!sanitizeFilenames.value) {
      const identity: Record<string, string> = {};
      for (const f of memberFiles) identity[f.path] = f.path;
      return { byPath: identity };
    }
    const result = anonymizeLocalFiles(memberFiles, pending.value, {
      startAt: startAt.value,
      dropParentDirs: dropParentDirs.value,
    });
    const byPath: Record<string, string> = {};
    memberFiles.forEach((f, i) => {
      byPath[f.path] = result.files[i].path;
    });
    return { byPath };
  });

  const rows = computed<LocalAnonRow[]>(() =>
    filesets.value.map((fs) => {
      const ok = isWasmAnonSupported(fs.main);
      const state = runState.value[fs.main];
      return {
        index: fs.index,
        main: fs.main,
        name: basename(fs.main),
        format: extensionOf(fs.main) || 'unknown',
        fileCount: fs.files.length,
        size: fs.size,
        outputPath: ok ? state?.outputPath ?? plan.value.byPath[fs.main] ?? null : null,
        written: state?.written ?? 0,
        status: ok ? state?.status ?? 'queued' : 'unsupported',
        associated: state?.associated ?? [],
        notes: state?.notes ?? [],
        error: ok
          ? state?.error ?? null
          : `${extensionOf(fs.main) || 'This format'} is not supported by the browser anonymizer`,
      };
    })
  );

  const totalBytes = computed(() => supported.value.reduce((s, fs) => s + fs.size, 0));
  const writtenBytes = computed(() =>
    supported.value.reduce((s, fs) => s + (runState.value[fs.main]?.written ?? 0), 0)
  );
  const percent = computed(() =>
    totalBytes.value ? Math.min(100, (writtenBytes.value / totalBytes.value) * 100) : 0
  );
  const doneCount = computed(() => rows.value.filter((r) => r.status === 'done').length);
  const failedCount = computed(() => rows.value.filter((r) => r.status === 'failed').length);
  const hasRun = computed(() => lastRunAt.value != null);

  /** Download fallback cannot write folders, so only single-file slides work. */
  const fallbackBlocked = computed(() =>
    canPickFolder ? [] : supported.value.filter((fs) => fs.files.length > 1).map((fs) => fs.main)
  );

  const missing = computed(() => {
    const out: string[] = [];
    if (!supported.value.length) out.push('Add at least one supported slide');
    else if (!pending.value.length) out.push('All slides are already saved — add more or start a new batch');
    if (canPickFolder && !outputDir.value) out.push('Choose an output folder');
    if (!sanitizeFilenames.value && !filenameClean.value) {
      out.push('Confirm filenames are free of patient IDs (or turn on sanitize)');
    }
    if (!residualRiskAck.value) out.push('Acknowledge residual re-identification risk');
    return out;
  });
  const canRun = computed(() => !running.value && missing.value.length === 0);

  /* ----------------------------- Selection ------------------------------ */

  function resetRun(): void {
    runState.value = {};
    message.value = null;
    error.value = null;
  }

  function addFiles(incoming: LocalFile[]): number {
    if (running.value) return 0;
    const seen = new Set(files.value.map((f) => f.path));
    const added = incoming.filter((f) => !seen.has(f.path));
    if (added.length) files.value = [...files.value, ...added];
    return added.length;
  }

  function removeFileset(index: number): void {
    if (running.value) return;
    const target = filesets.value.find((fs) => fs.index === index);
    if (!target) return;
    const drop = new Set(target.files.map((f) => f.path));
    files.value = files.value.filter((f) => !drop.has(f.path));
    const { [target.main]: _removed, ...rest } = runState.value;
    runState.value = rest;
  }

  function clear(): void {
    if (running.value) return;
    files.value = [];
    lastMapping.value = {};
    lastAssociated.value = {};
    lastRunAt.value = null;
    mappingCsvPath.value = null;
    mappingCsvError.value = null;
    resetRun();
  }

  /* ---------------------------- Output folder --------------------------- */

  /** Folders (relative to output) that will receive slide-NNNN entries. */
  function targetParentDirs(): string[] {
    const dirs = new Set<string>(['']);
    if (sanitizeFilenames.value && !dropParentDirs.value) {
      for (const fs of pending.value) {
        const slash = fs.main.lastIndexOf('/');
        dirs.add(slash < 0 ? '' : fs.main.slice(0, slash));
      }
    }
    return [...dirs];
  }

  async function refreshStartAt(): Promise<void> {
    if (!outputDir.value || running.value) return;
    try {
      // Also past slides listed in the mapping file: the anonymized slides may
      // have been moved out of the folder while their labels and rows remain.
      const listed = (await listedAnonymizedPaths(outputDir.value).catch(() => []))
        .map((p) => slideNumberOf(basename(p)) ?? 0);
      startAt.value = Math.max(
        await nextSlideNumber(outputDir.value, targetParentDirs()),
        ...listed.map((n) => n + 1)
      );
    } catch {
      /* listing is best-effort; collisions are still checked before writing */
    }
  }

  /** Returns false if the user dismissed the picker. */
  async function chooseOutputDir(): Promise<boolean> {
    try {
      outputDir.value = await pickOutputDirectory();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      throw err;
    }
    resetRun();
    await refreshStartAt();
    return true;
  }

  /** Planned output paths that already exist in the output folder. */
  async function findConflicts(): Promise<string[]> {
    const dir = outputDir.value;
    if (!dir) return [];
    if (!(await ensureWritePermission(dir))) {
      throw new Error('Write permission to the output folder was not granted.');
    }
    const conflicts: string[] = [];
    for (const out of new Set(Object.values(plan.value.byPath))) {
      if (await pathExists(dir, out)) conflicts.push(out);
    }
    if (saveAssociated.value) {
      for (const fs of pending.value) {
        const outMain = plan.value.byPath[fs.main] ?? fs.main;
        for (const kind of ['label', 'macro'] as const) {
          for (const ext of ASSOCIATED_EXTS) {
            const p = `${associatedBase(outMain, kind)}.${ext}`;
            if (await pathExists(dir, p)) conflicts.push(p);
          }
        }
      }
    }
    return conflicts.sort();
  }

  /* -------------------------------- Run --------------------------------- */

  function setState(main: string, patch: Partial<RunState>): void {
    const prev: RunState = runState.value[main] ?? {
      status: 'queued',
      written: 0,
      error: null,
      outputPath: null,
      associated: [],
      notes: [],
    };
    runState.value = { ...runState.value, [main]: { ...prev, ...patch } };
  }

  async function saveFileset(
    fs: LocalFileset,
    sources: Record<string, AnonymizedChunkSource>,
    byPath: Record<string, string>,
    signal: AbortSignal
  ): Promise<void> {
    let written = 0;
    const onBytes = (n: number) => {
      written += n;
      setState(fs.main, { written });
    };
    for (const member of fs.files) {
      const source = sources[member.path];
      const outPath = byPath[member.path] ?? member.path;
      if (outputDir.value) {
        await writeAnonymizedFile(outputDir.value, outPath, source, { signal, onBytes });
      } else {
        await downloadAnonymizedFile(basename(outPath), source, { signal, onBytes });
      }
    }
  }

  /**
   * Read the original label / macro out of the untouched source file and save
   * them as labels/<anon-name>_label.<ext> and macros/<anon-name>_macro.<ext>.
   * Format problems become notes; a failure to WRITE throws (fails the slide).
   */
  async function saveAssociatedImages(
    fs: LocalFileset,
    outMain: string,
    signal: AbortSignal
  ): Promise<{ saved: string[]; notes: string[]; noLabel: boolean }> {
    if (!supportsAssociatedExtraction(fs.main)) {
      const ext = extensionOf(fs.main);
      return {
        saved: [],
        notes: [`Saving labels / macros is not supported for ${ext} yet`],
        noLabel: false,
      };
    }
    const { images, notes, complete } = await extractAssociatedImages(fs);
    // Only claim "no label" when the whole slide was read without errors.
    const noLabel = complete && !images.some((img) => img.kind === 'label');
    const saved: string[] = [];
    const used = new Map<string, number>();
    for (const img of images) {
      const base = associatedBase(outMain, img.kind);
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const path = `${base}${n > 1 ? `-${n}` : ''}.${img.ext}`;
      const source = blobSource(path, img.blob);
      if (outputDir.value) {
        await writeAnonymizedFile(outputDir.value, path, source, { signal });
      } else {
        await downloadAnonymizedFile(basename(path), source, { signal });
      }
      saved.push(path);
    }
    return { saved, notes, noLabel };
  }

  /**
   * Scrub and save every pending slide. Per-slide failures are recorded and
   * the batch continues; `cancel()` stops after the current chunk. Slides that
   * were already saved are left alone, so a retry never duplicates them.
   */
  async function run(): Promise<void> {
    if (!canRun.value) return;
    const dir = outputDir.value;
    if (dir && !(await ensureWritePermission(dir))) {
      error.value = 'Write permission to the output folder was not granted.';
      return;
    }

    running.value = true;
    error.value = null;
    abort = new AbortController();
    const signal = abort.signal;
    const work = [...pending.value];
    const byPath = { ...plan.value.byPath };
    lastRunAt.value = new Date().toISOString();
    mappingCsvError.value = null;
    for (const fs of work) {
      setState(fs.main, {
        status: 'queued',
        written: 0,
        error: null,
        outputPath: byPath[fs.main] ?? fs.main,
        associated: [],
        notes: [],
      });
    }

    let csvPath: string | null = null;
    if (dir) {
      try {
        csvPath = await mappingCsvForAppend(dir);
      } catch (err) {
        mappingCsvError.value = err instanceof Error ? err.message : String(err);
      }
    }
    /** Add the row after every saved slide so a crash never loses the key. */
    async function recordMapping(fs: LocalFileset, outMain: string, noLabel: boolean): Promise<void> {
      if (!dir || !csvPath) return;
      const saved = runState.value[fs.main]?.associated ?? [];
      const of = (sub: string) => saved.filter((p) => p.startsWith(`${sub}/`)).join(';');
      try {
        await appendMappingRecord(dir, csvPath, {
          original_path: fs.main,
          anonymized_path: outMain,
          original_filename: basename(fs.main),
          anonymized_filename: basename(outMain),
          label_files: of(LABELS_DIR),
          macro_files: of(MACROS_DIR),
          anonymized_at: new Date().toISOString(),
          wsi_anon_version: toolVersion.value ?? '',
          // A replaced slide must not inherit the previous slide's label reading.
          label_text: '',
          // `none` = the slide has no label image (step 2 shows "No label found").
          label_status: noLabel ? 'none' : '',
          label_ocr_confidence: '',
          label_rotation: '',
        });
        mappingCsvPath.value = csvPath;
        mappingCsvError.value = null;
      } catch (err) {
        mappingCsvError.value = err instanceof Error ? err.message : String(err);
      }
    }

    try {
      toolVersion.value = await wsiAnonVersion();
      for (const [i, fs] of work.entries()) {
        if (signal.aborted) {
          setState(fs.main, { status: 'cancelled' });
          continue;
        }
        if (fallbackBlocked.value.includes(fs.main)) {
          setState(fs.main, {
            status: 'failed',
            error: 'Multi-file slide — saving a folder needs Chrome or Edge.',
          });
          continue;
        }
        const label = `${i + 1}/${work.length}: ${basename(fs.main)}`;
        let sources: Record<string, AnonymizedChunkSource> = {};
        try {
          let noLabel = false;
          if (saveAssociated.value) {
            message.value = `Saving original label & macro ${label}`;
            setState(fs.main, { status: 'extracting', written: 0, error: null });
            const outMain = byPath[fs.main] ?? fs.main;
            const saved = await saveAssociatedImages(fs, outMain, signal);
            noLabel = saved.noLabel;
            setState(fs.main, { associated: saved.saved, notes: saved.notes });
            if (saved.saved.length) {
              lastAssociated.value = { ...lastAssociated.value, [fs.main]: saved.saved };
            }
          }

          message.value = `Scrubbing label & metadata ${label}`;
          setState(fs.main, { status: 'scrubbing', written: 0, error: null });
          // Our own metadata scrub for Aperio slides (null for other formats).
          let plan: MetadataScrubPlan | null = null;
          try {
            plan = await planMetadataScrub(fs);
          } catch {
            plan = null;
          }
          if (plan && !plan.hasLabel) noLabel = true;
          try {
            sources = await anonymizeFilesetWasm(fs, { keyPrefix: WASM_KEY_PREFIX });
            // WSI-anon keeps some identifying fields (e.g. Aperio `Title`); blank them too.
            if (plan?.edits.length && sources[fs.main]) {
              sources[fs.main] = withByteEdits(sources[fs.main], plan.edits);
            }
          } catch (err) {
            // WSI-anon refuses slides that have no label image. When the slide has
            // neither a label nor a macro there is no image to remove: rename it
            // and remove the identifying metadata ourselves.
            const member = fs.files.find((f) => f.path === fs.main);
            if (!plan || plan.hasLabel || plan.hasMacro || !member) throw err;
            sources = { [fs.main]: withByteEdits(plainSource(fs.main, member.file), plan.edits) };
            const notes = (runState.value[fs.main]?.notes ?? []).filter((n) => n !== NO_ASSOCIATED_NOTE);
            setState(fs.main, {
              notes: [
                ...notes,
                'No label or macro image in this slide — renamed and identifying metadata removed',
              ],
            });
          }

          message.value = `Saving ${label}`;
          setState(fs.main, { status: 'writing' });
          await saveFileset(fs, sources, byPath, signal);
          setState(fs.main, { status: 'done', written: fs.size });
          reportSlide({
            bytes: fs.size,
            format: extensionOf(fs.main).replace(/^\./, '') || 'unknown',
            files: fs.files.length,
          });
          const renamed: Record<string, string> = {};
          for (const member of fs.files) {
            const out = byPath[member.path] ?? member.path;
            if (out !== member.path) renamed[member.path] = out;
          }
          lastMapping.value = { ...lastMapping.value, ...renamed };
          await recordMapping(fs, byPath[fs.main] ?? fs.main, noLabel);
        } catch (err) {
          const cancelled = err instanceof DOMException && err.name === 'AbortError';
          // Don't leave the label / macro of a slide that was not saved.
          const orphans = runState.value[fs.main]?.associated ?? [];
          if (outputDir.value) {
            for (const p of orphans) await removePath(outputDir.value, p);
          }
          if (orphans.length) {
            const { [fs.main]: _dropped, ...keep } = lastAssociated.value;
            lastAssociated.value = keep;
          }
          setState(fs.main, {
            associated: [],
            status: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? null : err instanceof Error ? err.message : String(err),
          });
        } finally {
          destroyAnonSources(sources);
        }
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Anonymization failed';
    } finally {
      running.value = false;
      abort = null;
    }

    const done = work.filter((fs) => runState.value[fs.main]?.status === 'done').length;
    const failed = work.filter((fs) => runState.value[fs.main]?.status === 'failed').length;
    message.value = signal.aborted
      ? `Cancelled — ${done} of ${work.length} slide(s) saved.`
      : `Saved ${done} of ${work.length} slide(s)${failed ? ` · ${failed} failed` : ''}.`;
    // Next run into the same folder continues numbering after these slides.
    await refreshStartAt();
  }

  function cancel(): void {
    abort?.abort();
  }

  return {
    files,
    filesets,
    skipped,
    supported,
    pending,
    rows,
    sanitizeFilenames,
    dropParentDirs,
    startAt,
    residualRiskAck,
    filenameClean,
    saveAssociated,
    canPickFolder,
    outputDir,
    running,
    message,
    error,
    toolVersion,
    lastMapping,
    lastAssociated,
    lastRunAt,
    mappingCsvPath,
    mappingCsvError,
    totalBytes,
    writtenBytes,
    percent,
    doneCount,
    failedCount,
    hasRun,
    fallbackBlocked,
    missing,
    canRun,
    addFiles,
    removeFileset,
    clear,
    chooseOutputDir,
    refreshStartAt,
    findConflicts,
    run,
    cancel,
  };
});
