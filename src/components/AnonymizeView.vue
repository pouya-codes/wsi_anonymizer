<script setup lang="ts">
import { NO_ASSOCIATED_NOTE } from '@/upload/associatedImages';
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputNumber from 'primevue/inputnumber';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import {
  LABELS_DIR,
  MACROS_DIR,
  useLocalAnonStore,
  type LocalAnonStatus,
} from '@/stores/localAnon';
import { filesFromDataTransfer, filesFromFileList } from '@/upload/filesets';
import { MAPPING_CSV_NAME } from '@/upload/mappingCsv';
import { currentView, openGuide } from '@/stores/nav';
import { WASM_ANON_EXTENSIONS } from '@/upload/wsiAnon';
import { formatBytes, shortenPath } from '@/utils/format';
import {
  basename,
  downloadMappingCsv,
  downloadMappingJson,
  mappingRowsOf,
} from '@/utils/mappingExport';

const anon = useLocalAnonStore();
const confirm = useConfirm();
const toast = useToast();

const formatList = [...WASM_ANON_EXTENSIONS].join(', ');
const dragging = ref(false);
const scanning = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);

const locked = computed(() => anon.running);
const overallPercent = computed(() => Math.round(anon.percent));
const mappingRows = computed(() => mappingRowsOf(anon.lastMapping));
const associatedCount = computed(() =>
  Object.values(anon.lastAssociated).reduce((n, paths) => n + paths.length, 0)
);
const hasExportable = computed(() => mappingRows.value.length > 0 || associatedCount.value > 0);

/** The slide has no label or macro image at all (not an error). */
function hasNoAssociated(notes: string[]): boolean {
  return notes.some((n) => n === NO_ASSOCIATED_NOTE || n.startsWith('No label or macro image in this slide'));
}

function associatedSummary(paths: string[]): string {
  const labels = paths.filter((p) => p.startsWith(`${LABELS_DIR}/`)).length;
  const macros = paths.filter((p) => p.startsWith(`${MACROS_DIR}/`)).length;
  return [labels && `${labels} label`, macros && `${macros} macro`].filter(Boolean).join(' · ');
}

const STATUS_BADGE: Record<LocalAnonStatus, string> = {
  queued: 'queued',
  unsupported: 'cancelled',
  extracting: 'importing',
  scrubbing: 'importing',
  writing: 'uploading',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};
const STATUS_LABEL: Record<LocalAnonStatus, string> = {
  queued: 'Queued',
  unsupported: 'Unsupported',
  extracting: 'Saving label',
  scrubbing: 'Scrubbing',
  writing: 'Saving',
  done: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Changing where slide-NNNN names land changes which numbers are free.
watch(
  () => [anon.sanitizeFilenames, anon.dropParentDirs],
  () => void anon.refreshStartAt()
);

function report(added: number, total: number): void {
  if (!added) {
    toast.add({
      severity: 'warn',
      summary: 'Nothing added',
      detail: total ? 'Those files are already in the list.' : 'No files were found.',
      life: 4000,
    });
    return;
  }
  const skipped = anon.skipped.length;
  toast.add({
    severity: 'success',
    summary: `${added} file(s) added`,
    detail: skipped ? `${skipped} unrelated file(s) will be ignored.` : undefined,
    life: 4000,
  });
}

async function onDrop(event: DragEvent): Promise<void> {
  dragging.value = false;
  if (!event.dataTransfer || locked.value) return;
  scanning.value = true;
  try {
    const files = await filesFromDataTransfer(event.dataTransfer);
    report(anon.addFiles(files), files.length);
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not read the dropped items',
      detail: err instanceof Error ? err.message : undefined,
      life: 5000,
    });
  } finally {
    scanning.value = false;
  }
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = filesFromFileList(input.files);
  report(anon.addFiles(files), files.length);
  input.value = '';
}

async function onChooseFolder(): Promise<void> {
  try {
    await anon.chooseOutputDir();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not open that folder',
      detail: err instanceof Error ? err.message : undefined,
      life: 6000,
    });
  }
}

async function startRun(): Promise<void> {
  await anon.run();
  const severity = anon.error || anon.failedCount ? 'warn' : 'success';
  toast.add({
    severity,
    summary: anon.error ? 'Anonymization stopped' : 'Anonymization finished',
    detail: anon.error ?? anon.message ?? undefined,
    life: 7000,
  });
}

async function onRun(): Promise<void> {
  if (!anon.canRun) return;
  let conflicts: string[] = [];
  try {
    conflicts = await anon.findConflicts();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Cannot write to the output folder',
      detail: err instanceof Error ? err.message : undefined,
      life: 6000,
    });
    return;
  }
  if (!conflicts.length) {
    await startRun();
    return;
  }
  const preview = conflicts.slice(0, 5).map((p) => `• ${p}`).join('\n');
  confirm.require({
    header: 'Replace existing files?',
    message:
      `${conflicts.length} file(s) already exist in the output folder and will be replaced:\n` +
      `${preview}${conflicts.length > 5 ? '\n…' : ''}\n\n` +
      'Never choose the folder that holds the original slides when filenames are not sanitized.',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Replace',
    acceptClass: 'p-button-danger',
    accept: () => void startRun(),
  });
}

function onClear(): void {
  // Nothing to lose when the mapping is already in the output folder.
  if (!anon.lastRunAt || !mappingRows.value.length || anon.mappingCsvPath) {
    anon.clear();
    return;
  }
  confirm.require({
    header: 'Start a new batch?',
    message:
      'The filename mapping for this batch will be discarded. Download it first if you need to trace slides back to their source.',
    icon: 'pi pi-info-circle',
    rejectLabel: 'Keep',
    acceptLabel: 'Start new batch',
    accept: () => anon.clear(),
  });
}

function downloadCsv(): void {
  downloadMappingCsv(anon.lastMapping, 'local-anonymize-mapping.csv');
}

function downloadJson(): void {
  downloadMappingJson(anon.lastMapping, 'local-anonymize-mapping.json', {
    tool: 'EMPAIA WSI-anon (browser WASM)',
    tool_version: anon.toolVersion,
    output_folder: anon.outputDir?.name ?? null,
    // original slide → original label / macro images saved in the output folder
    associated_images: anon.lastAssociated,
  });
}

function rowPercent(written: number, size: number): number {
  return size ? Math.min(100, (written / size) * 100) : 0;
}
</script>

<template>
  <div>
    <div class="view-header">
      <div>
        <h1>Anonymize whole-slide images</h1>
        <p>
          Remove label, macro and identifying metadata from slides on this computer
          and save anonymized copies to a folder you choose. Everything runs inside
          your browser — slides are never uploaded and your originals are never
          modified.
        </p>
      </div>
      <Button
        label="How this step works"
        icon="pi pi-question-circle"
        text
        size="small"
        class="help-link"
        @click="openGuide('step1')"
      />
    </div>

    <div
      v-if="!anon.canPickFolder"
      class="banner banner--warn"
    >
      This browser cannot save into a folder, so each anonymized slide will be offered
      as a download (single-file slides up to 2 GB only). Use Chrome or Edge to save
      large slides and multi-file formats such as MRXS directly into a folder.
    </div>

    <!-- 1. SELECT -->
    <div class="card">
      <h2 class="card__title">1 · Slides</h2>
      <div
        class="dropzone"
        :class="{ dragging }"
        @click="!locked && fileInput?.click()"
        @dragover.prevent="dragging = true"
        @dragenter.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <i class="pi pi-shield dropzone__icon" />
        <div class="dropzone__title">
          {{ scanning ? 'Reading selection…' : 'Drop slides or folders here' }}
        </div>
        <div>Supported: {{ formatList }}</div>
      </div>

      <input
        ref="fileInput"
        type="file"
        multiple
        hidden
        @change="onPick"
      />
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        hidden
        @change="onPick"
      />

      <div
        class="button-row"
        style="margin-top: 14px"
      >
        <Button
          label="Add files"
          icon="pi pi-file"
          outlined
          :disabled="locked"
          @click="fileInput?.click()"
        />
        <Button
          label="Add folder"
          icon="pi pi-folder-open"
          outlined
          :disabled="locked"
          @click="folderInput?.click()"
        />
        <Button
          :label="anon.hasRun ? 'Start new batch' : 'Clear'"
          icon="pi pi-trash"
          text
          severity="secondary"
          :disabled="locked || !anon.rows.length"
          @click="onClear"
        />
      </div>

      <table
        v-if="anon.rows.length"
        class="queue-table"
        style="margin-top: 14px"
      >
        <thead>
          <tr>
            <th>Slide</th>
            <th>Saved as</th>
            <th v-if="anon.saveAssociated || anon.hasRun">Label / macro</th>
            <th class="num">Files</th>
            <th class="num">Size</th>
            <th style="width: 130px">Progress</th>
            <th>Status</th>
            <th style="width: 40px" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in anon.rows"
            :key="row.main"
          >
            <td :title="row.main">
              {{ shortenPath(row.main, 48) }}
            </td>
            <td>
              <code
                v-if="row.outputPath"
                :title="row.outputPath"
              >{{ shortenPath(row.outputPath, 40) }}</code>
              <span
                v-else
                class="hint"
              >—</span>
            </td>
            <td v-if="anon.saveAssociated || anon.hasRun">
              <span
                v-if="row.associated.length"
                v-tooltip.top="row.associated.join('\n')"
                class="assoc-ok"
              >
                <i class="pi pi-image" /> {{ associatedSummary(row.associated) }}
              </span>
              <span
                v-else-if="row.status === 'unsupported' || row.status === 'queued'"
                class="hint"
              >—</span>
              <span
                v-else-if="hasNoAssociated(row.notes)"
                class="assoc-none"
              >
                <i class="pi pi-ban" /> no label in slide
              </span>
              <span
                v-else-if="row.notes.length"
                class="assoc-note"
              >
                <i class="pi pi-exclamation-triangle" /> none saved
              </span>
              <div
                v-for="note in row.notes"
                :key="note"
                class="hint row-note"
              >{{ note }}</div>
            </td>
            <td class="num">{{ row.fileCount }}</td>
            <td class="num">{{ formatBytes(row.size) }}</td>
            <td>
              <div class="progress">
                <div
                  class="progress__fill"
                  :style="{ width: `${rowPercent(row.written, row.size)}%` }"
                />
              </div>
            </td>
            <td>
              <span
                class="badge"
                :class="`badge--${STATUS_BADGE[row.status]}`"
              >
                <i
                  v-if="row.status === 'scrubbing' || row.status === 'writing'"
                  class="pi pi-spin pi-spinner"
                  style="font-size: 10px; margin-right: 4px"
                />{{ STATUS_LABEL[row.status] }}
              </span>
              <div
                v-if="row.error"
                class="error-text row-error"
              >{{ row.error }}</div>
            </td>
            <td>
              <Button
                v-if="!locked"
                v-tooltip.left="'Remove'"
                icon="pi pi-times"
                text
                rounded
                severity="secondary"
                size="small"
                @click="anon.removeFileset(row.index)"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p
        v-if="anon.skipped.length"
        class="hint"
        style="margin: 10px 0 0"
      >
        {{ anon.skipped.length }} file(s) are not slides or companion files and will be ignored.
      </p>
    </div>

    <!-- 2. OUTPUT -->
    <div class="card">
      <h2 class="card__title">2 · Save to</h2>
      <template v-if="anon.canPickFolder">
        <div class="output-row">
          <Button
            :label="anon.outputDir ? 'Change folder' : 'Choose output folder'"
            icon="pi pi-folder"
            :outlined="!!anon.outputDir"
            :disabled="locked"
            @click="onChooseFolder"
          />
          <span
            v-if="anon.outputDir"
            class="output-name"
          >
            <i class="pi pi-folder-open" />
            {{ anon.outputDir.name }}
          </span>
          <span
            v-else
            class="hint"
          >No folder chosen yet.</span>
        </div>
        <p
          class="hint"
          style="margin: 10px 0 0"
        >
          Your browser asks for permission to write to the folder. Pick an empty folder
          (or a previous output folder — numbering continues after existing
          <code>slide-NNNN</code> files). Do not pick the folder holding the originals.
        </p>
      </template>
      <p
        v-else
        class="hint"
        style="margin: 0"
      >
        Files will be saved to your browser's download folder.
      </p>
    </div>

    <!-- 3. OPTIONS + ATTEST -->
    <div class="card">
      <h2 class="card__title">3 · Anonymization</h2>

      <div class="check-row check-row--static">
        <i class="pi pi-check-circle check-row__fixed" />
        <span>
          <span class="check-row__label">Label / macro / metadata scrub (always on)</span>
          <span class="hint">
            EMPAIA WSI-anon runs in this browser and replaces label and macro images
            and strips identifying metadata — the same scrub cPathPortal uses on import.
          </span>
        </span>
      </div>

      <label class="check-row">
        <Checkbox
          v-model="anon.sanitizeFilenames"
          :binary="true"
          :disabled="locked"
        />
        <span>
          <span class="check-row__label">Sanitize filenames to slide-NNNN</span>
          <span class="hint">
            Saves <code>Patient123_HE.svs</code> as <code>slide-0001.svs</code>. The
            original → new name mapping is saved as <code>{{ MAPPING_CSV_NAME }}</code> in the
            output folder — keep it apart from the slides when sharing.
          </span>
        </span>
      </label>

      <template v-if="anon.sanitizeFilenames">
        <label class="check-row check-row--nested">
          <Checkbox
            v-model="anon.dropParentDirs"
            :binary="true"
            :disabled="locked"
          />
          <span>
            <span class="check-row__label">Drop source folder names</span>
            <span class="hint">
              Save every slide at the top of the output folder instead of recreating
              source folders such as <code>Smith_John/</code>.
            </span>
          </span>
        </label>
        <div class="check-row check-row--nested start-row">
          <span class="check-row__label">Start numbering at</span>
          <InputNumber
            v-model="anon.startAt"
            :min="1"
            :max="9999"
            :use-grouping="false"
            :disabled="locked"
            input-class="start-input"
          />
        </div>
      </template>

      <label
        v-else
        class="check-row"
      >
        <Checkbox
          v-model="anon.filenameClean"
          :binary="true"
          :disabled="locked"
        />
        <span>
          <span class="check-row__label">Filenames are free of patient IDs</span>
          <span class="hint">
            Original names and folders are kept. Confirm they contain no patient name,
            MRN, accession, DOB or other identifiers.
          </span>
        </span>
      </label>

      <label class="check-row">
        <Checkbox
          v-model="anon.saveAssociated"
          :binary="true"
          :disabled="locked"
        />
        <span>
          <span class="check-row__label">Keep the original label &amp; macro images</span>
          <span class="hint">
            Before scrubbing, the untouched label and macro are saved into
            <code>{{ LABELS_DIR }}/</code> and <code>{{ MACROS_DIR }}/</code> inside the output
            folder, named after the anonymized slide (e.g.
            <code>{{ LABELS_DIR }}/slide-0001_label.png</code>,
            <code>{{ MACROS_DIR }}/slide-0001_macro.jpg</code>). Supported for SVS, NDPI, BIF,
            TIFF and iSyntax.
          </span>
        </span>
      </label>
      <div
        v-if="anon.saveAssociated"
        class="banner banner--warn phi-warning"
      >
        <i class="pi pi-exclamation-triangle" />
        Labels and macros usually show patient name, MRN or barcode.
        Delete or move the <code>{{ LABELS_DIR }}/</code> and <code>{{ MACROS_DIR }}/</code>
        folders and <code>{{ MAPPING_CSV_NAME }}</code> before sharing the output folder.
      </div>

      <label class="check-row">
        <Checkbox
          v-model="anon.residualRiskAck"
          :binary="true"
          :disabled="locked"
        />
        <span>
          <span class="check-row__label">I understand residual visual re-identification risk</span>
          <span class="hint">
            Removing labels and metadata does not remove the tissue itself; rare
            morphology or disease presentation can still allow re-identification.
          </span>
        </span>
      </label>
    </div>

    <!-- 4. RUN -->
    <div class="card">
      <div
        class="row-between"
        style="margin-bottom: 12px"
      >
        <h2
          class="card__title"
          style="margin: 0"
        >
          4 · Run — {{ anon.pending.length }} slide(s) to save
        </h2>
        <span
          v-if="anon.running || anon.hasRun"
          class="hint"
        >
          {{ formatBytes(anon.writtenBytes) }} of {{ formatBytes(anon.totalBytes) }}
          · {{ anon.doneCount }} saved
          <template v-if="anon.failedCount"> · {{ anon.failedCount }} failed</template>
        </span>
      </div>

      <div
        v-if="anon.running || anon.hasRun"
        class="progress progress--lg"
        style="margin-bottom: 14px"
      >
        <div
          class="progress__fill"
          :style="{ width: `${overallPercent}%` }"
        />
      </div>

      <div
        v-if="anon.error"
        class="banner banner--error"
      >
        {{ anon.error }}
      </div>
      <div
        v-else-if="anon.message"
        class="banner banner--info"
      >
        {{ anon.message }}
      </div>
      <div
        v-if="anon.mappingCsvError"
        class="banner banner--warn"
      >
        <i class="pi pi-exclamation-triangle" />
        Could not save <code>{{ MAPPING_CSV_NAME }}</code> to the output folder
        ({{ anon.mappingCsvError }}). Download the mapping below instead.
      </div>
      <div
        v-else-if="anon.mappingCsvPath && !anon.running"
        class="banner banner--info"
      >
        <i class="pi pi-file" />
        Mapping saved to
        <code>{{ anon.outputDir?.name ? `${anon.outputDir.name}/` : '' }}{{ anon.mappingCsvPath }}</code>.
        <Button
          v-if="associatedCount"
          label="Next: read labels"
          icon="pi pi-arrow-right"
          icon-pos="right"
          size="small"
          class="next-step-btn"
          @click="currentView = 'labels'"
        />
      </div>

      <ul
        v-if="!anon.running && anon.missing.length"
        class="missing-list"
      >
        <li
          v-for="item in anon.missing"
          :key="item"
        >
          <i class="pi pi-circle" /> {{ item }}
        </li>
      </ul>

      <div class="button-row">
        <Button
          v-if="!anon.running"
          :label="anon.hasRun && anon.pending.length ? 'Retry remaining' : 'Anonymize & save'"
          icon="pi pi-shield"
          :disabled="!anon.canRun"
          @click="onRun"
        />
        <Button
          v-else
          label="Cancel"
          icon="pi pi-ban"
          severity="danger"
          outlined
          @click="anon.cancel()"
        />
      </div>
      <p
        class="hint"
        style="margin: 10px 0 0"
      >
        Keep this tab open while slides are being saved.
      </p>
    </div>

    <!-- 5. MAPPING -->
    <div
      v-if="hasExportable"
      class="card"
    >
      <div
        class="row-between"
        style="margin-bottom: 10px"
      >
        <h2
          class="card__title"
          style="margin: 0"
        >
          Filename mapping
          <template v-if="associatedCount"> · {{ associatedCount }} label / macro image(s) saved</template>
        </h2>
        <div class="button-row">
          <Button
            label="Download CSV"
            icon="pi pi-download"
            outlined
            size="small"
            :disabled="!mappingRows.length"
            @click="downloadCsv"
          />
          <Button
            label="Download JSON"
            icon="pi pi-download"
            outlined
            size="small"
            @click="downloadJson"
          />
        </div>
      </div>
      <p
        class="hint"
        style="margin: 0 0 10px"
      >
        This mapping links anonymized slides back to their originals.
        <template v-if="anon.mappingCsvPath">
          It was also saved as <code>{{ anon.mappingCsvPath }}</code> in the output folder —
          remove it before sharing the folder and store it securely.
        </template>
        <template v-else>
          Store it separately and securely.
        </template>
      </p>
      <div
        v-if="mappingRows.length"
        class="map-table-wrap"
      >
        <table class="map-table">
          <thead>
            <tr>
              <th>Original</th>
              <th>Anonymized</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in mappingRows"
              :key="row.original"
            >
              <td>
                <code :title="row.original">{{ basename(row.original) }}</code>
                <div
                  v-if="row.original.includes('/')"
                  class="hint path-hint"
                >{{ row.original }}</div>
              </td>
              <td>
                <code :title="row.anonymized">{{ basename(row.anonymized) }}</code>
                <div
                  v-if="row.anonymized.includes('/')"
                  class="hint path-hint"
                >{{ row.anonymized }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.check-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 12px;
  cursor: pointer;
}

.check-row--static {
  cursor: default;
}

.check-row--nested {
  margin-left: 30px;
}

.check-row__fixed {
  color: var(--accent-2);
  font-size: 18px;
  margin-top: 1px;
}

.check-row__label {
  display: block;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}

.start-row {
  align-items: center;
  cursor: default;
}

.start-row .check-row__label {
  margin: 0;
}

:deep(.start-input) {
  width: 90px;
}

.output-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.output-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.output-name i {
  color: var(--accent);
}

.assoc-ok {
  color: var(--accent-2);
  white-space: nowrap;
}

.assoc-none {
  color: var(--text-dim);
  white-space: nowrap;
}

.assoc-note {
  color: var(--warn);
  white-space: nowrap;
}

.row-note {
  font-size: 11px;
  max-width: 220px;
}

.phi-warning {
  margin: -4px 0 14px 30px;
}

.phi-warning i {
  margin-right: 6px;
}

.row-error {
  font-size: 11px;
  margin-top: 4px;
  max-width: 260px;
}

.missing-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.8;
}

.missing-list i {
  font-size: 10px;
  margin-right: 6px;
}

.map-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.map-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.map-table th,
.map-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.map-table th {
  background: var(--bg);
  font-weight: 600;
}

.map-table code {
  font-size: 12px;
  word-break: break-all;
}

.path-hint {
  margin-top: 2px;
  word-break: break-all;
}
.next-step-btn {
  margin-left: 10px;
  vertical-align: middle;
}
</style>
