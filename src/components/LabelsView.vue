<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { useLabelsStore, type LabelFilter, type LabelRow } from '@/stores/labels';
import { useLocalAnonStore } from '@/stores/localAnon';
import { currentView, openGuide } from '@/stores/nav';
import { MAPPING_CSV_NAME } from '@/upload/mappingCsv';

const labels = useLabelsStore();
const anon = useLocalAnonStore();
const confirm = useConfirm();
const toast = useToast();

const canPickFolder = anon.canPickFolder;
const zoomed = ref<LabelRow | null>(null);

const filters: { value: LabelFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'todo', label: 'To review' },
  { value: 'reviewed', label: 'Reviewed' },
];

const ocrPercent = computed(() =>
  labels.ocrTotal ? Math.round((labels.ocrDone / labels.ocrTotal) * 100) : 0
);
const savedTime = computed(() =>
  labels.savedAt ? new Date(labels.savedAt).toLocaleTimeString() : null
);
/** Step 1's folder, offered as a one-click source when it is not open here yet. */
const offerAnonFolder = computed(
  () => !!anon.outputDir && !anon.running && labels.dir?.name !== anon.outputDir.name
);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function openFolder(): Promise<void> {
  if (labels.dirty && !(await confirmDiscard())) return;
  try {
    await labels.openFolder();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Could not open folder', detail: errMessage(err), life: 6000 });
  }
}

async function useAnonFolder(): Promise<void> {
  if (!anon.outputDir) return;
  if (labels.dirty && !(await confirmDiscard())) return;
  await labels.useFolder(anon.outputDir);
}

function confirmDiscard(): Promise<boolean> {
  return new Promise((resolve) =>
    confirm.require({
      header: 'Unsaved label text',
      message: `${labels.unsavedKeys.length} label(s) have unsaved changes. Discard them?`,
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Keep editing',
      acceptLabel: 'Discard',
      acceptClass: 'p-button-danger',
      accept: () => resolve(true),
      reject: () => resolve(false),
      onHide: () => resolve(false),
    })
  );
}

async function save(): Promise<void> {
  if (await labels.save()) {
    toast.add({ severity: 'success', summary: `Saved to ${labels.csvPath}`, life: 2500 });
  }
}

function readAgain(row: LabelRow): void {
  if (row.status !== 'edited' || !row.text.trim()) {
    void labels.runOcr([row.key]);
    return;
  }
  confirm.require({
    header: 'Read this label again?',
    message: 'The text you typed for this label will be replaced by the OCR result.',
    icon: 'pi pi-refresh',
    rejectLabel: 'Cancel',
    acceptLabel: 'Replace',
    accept: () => {
      labels.setReviewed(row.key, false);
      row.status = 'ocr';
      void labels.runOcr([row.key]);
    },
  });
}

/** Slides with no label at all are listed under "All" only (nothing to do for them). */
const showNoLabel = computed(() => labels.filter === 'all' && labels.noLabelRows.length > 0);

function statusLabel(row: LabelRow): string {
  switch (row.status) {
    case 'reviewed':
      return 'Reviewed';
    case 'edited':
      return 'Edited';
    case 'ocr':
      return row.confidence != null ? `OCR · ${row.confidence}%` : 'OCR';
    default:
      return 'Not read';
  }
}

function statusClass(row: LabelRow): string {
  if (row.status === 'reviewed') return 'badge--done';
  if (row.status === 'edited') return 'badge--uploaded';
  if (row.status === 'ocr') return (row.confidence ?? 0) >= 70 ? 'badge--importing' : 'badge--cancelled';
  return 'badge--queued';
}

/** Keep a rotated image inside its box: sideways swaps the size limits. */
function rotatedStyle(rotation: number, maxW: string, maxH: string): Record<string, string> {
  const sideways = rotation % 180 !== 0;
  return {
    transform: `rotate(${rotation}deg)`,
    maxWidth: sideways ? maxH : maxW,
    maxHeight: sideways ? maxW : maxH,
  };
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && currentView.value === 'labels') {
    e.preventDefault();
    void save();
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div>
    <div class="view-header">
      <div>
        <h1>Read labels</h1>
        <p>
          Record what each original slide label says (patient, case or block IDs) next
          to its anonymized slide. Labels are read on this computer with OCR, then you
          check and correct each one. Text is saved into the output folder's
          <code>{{ MAPPING_CSV_NAME }}</code> beside the label path, so you can stop and
          continue later by opening the same folder.
        </p>
      </div>
      <Button
        label="How this step works"
        icon="pi pi-question-circle"
        text
        size="small"
        class="help-link"
        @click="openGuide('step2')"
      />
    </div>

    <div
      v-if="!canPickFolder"
      class="banner banner--warn"
    >
      Reading labels needs access to the output folder. Use Chrome or Edge.
    </div>

    <!-- Folder -->
    <div class="card">
      <div class="row-between">
        <h2
          class="card__title"
          style="margin: 0"
        >
          Output folder
        </h2>
        <div class="button-row">
          <Button
            v-if="offerAnonFolder"
            :label="`Use “${anon.outputDir?.name}”`"
            icon="pi pi-folder"
            :disabled="labels.ocrRunning || labels.loading"
            @click="useAnonFolder"
          />
          <Button
            :label="labels.dir ? 'Open another folder' : 'Open output folder'"
            icon="pi pi-folder-open"
            :outlined="!!labels.dir || offerAnonFolder"
            :disabled="!canPickFolder || labels.ocrRunning || labels.loading"
            @click="openFolder"
          />
        </div>
      </div>
      <p
        v-if="!labels.dir"
        class="hint"
        style="margin: 10px 0 0"
      >
        Choose a folder that step 1 saved slides into. It must contain
        <code>{{ MAPPING_CSV_NAME }}</code> and the <code>labels/</code> folder.
      </p>
      <div
        v-else
        class="folder-summary"
      >
        <span><i class="pi pi-folder" /> <strong>{{ labels.dir.name }}</strong></span>
        <label
          v-if="labels.csvChoices.length > 1"
          class="hint"
        >
          File
          <select
            :value="labels.csvPath ?? ''"
            :disabled="labels.ocrRunning || labels.dirty"
            @change="labels.loadCsv(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="c in labels.csvChoices"
              :key="c"
              :value="c"
            >
              {{ c }}
            </option>
          </select>
        </label>
        <span
          v-else-if="labels.csvPath"
          class="hint"
        ><code>{{ labels.csvPath }}</code></span>
        <span
          v-if="labels.rows.length || labels.noLabelRows.length"
          class="hint"
        >
          {{ labels.rows.length }} label(s) · {{ labels.withTextCount }} with text ·
          {{ labels.reviewedCount }} reviewed
          <template v-if="labels.noLabelRows.length"> · {{ labels.noLabelRows.length }} slide(s) with no label</template>
          <template v-if="labels.withoutLabel"> · {{ labels.withoutLabel }} slide(s) without a saved label image</template>
        </span>
      </div>
      <div
        v-if="labels.error"
        class="banner banner--error"
        style="margin: 12px 0 0"
      >
        {{ labels.error }}
      </div>
    </div>

    <template v-if="labels.rows.length || labels.noLabelRows.length">
      <div class="banner banner--warn">
        <i class="pi pi-exclamation-triangle" />
        Label text is patient information. It is written only into
        <code>{{ labels.csvPath }}</code> in your folder — keep that file with the original
        labels, not with the anonymized slides you share.
      </div>

      <!-- Toolbar -->
      <div class="card toolbar-card">
        <div class="row-between">
          <div class="button-row">
            <Button
              v-if="!labels.ocrRunning"
              :label="labels.unreadRows.length ? `Read ${labels.unreadRows.length} label(s) with OCR` : 'All labels have text'"
              icon="pi pi-eye"
              :disabled="!labels.unreadRows.length"
              @click="labels.runOcr()"
            />
            <Button
              v-else
              label="Stop OCR"
              icon="pi pi-stop"
              severity="secondary"
              outlined
              @click="labels.cancelOcr()"
            />
            <div class="filter-group">
              <button
                v-for="f in filters"
                :key="f.value"
                type="button"
                class="filter-btn"
                :class="{ active: labels.filter === f.value }"
                @click="labels.filter = f.value"
              >
                {{ f.label }}
              </button>
            </div>
          </div>
          <div class="button-row">
            <span
              v-if="labels.dirty"
              class="hint"
            >{{ labels.unsavedKeys.length }} unsaved</span>
            <span
              v-else-if="savedTime"
              class="hint"
            ><i class="pi pi-check" /> Saved {{ savedTime }}</span>
            <Button
              v-tooltip.bottom="'Ctrl+S'"
              label="Save"
              icon="pi pi-save"
              :outlined="!labels.dirty"
              :loading="labels.saving"
              :disabled="!labels.dirty"
              @click="save"
            />
          </div>
        </div>

        <div
          v-if="labels.ocrRunning"
          class="progress"
          style="margin-top: 12px"
        >
          <div
            class="progress__fill"
            :style="{ width: `${ocrPercent}%` }"
          />
        </div>
        <p
          v-if="labels.ocrMessage"
          class="hint"
          style="margin: 8px 0 0"
        >
          {{ labels.ocrMessage }}
        </p>
        <p
          class="hint"
          style="margin: 8px 0 0"
        >
          OCR (Tesseract, running in this browser) reads printed labels well;
          handwriting usually needs to be typed in. OCR only fills labels that have no
          text yet and are not reviewed, and results are saved automatically.
        </p>
        <div
          v-if="labels.saveError"
          class="banner banner--error"
          style="margin: 10px 0 0"
        >
          Could not save: {{ labels.saveError }}
        </div>
      </div>

      <!-- Label list -->
      <div
        v-if="!labels.visibleRows.length && !showNoLabel"
        class="empty-state"
      >
        No labels in this view.
      </div>
      <div
        v-for="row in labels.visibleRows"
        :key="row.key"
        class="label-row"
        :class="{ 'label-row--reviewed': row.status === 'reviewed' }"
      >
        <div class="label-row__images">
          <div
            v-for="img in row.images"
            :key="img.path"
            class="label-img"
          >
            <button
              v-if="img.url"
              type="button"
              class="label-img__frame"
              title="Enlarge"
              @click="zoomed = row"
            >
              <img
                :src="img.url"
                :alt="`Label of ${row.anonymizedName}`"
                loading="lazy"
                :style="rotatedStyle(row.rotation, '260px', '200px')"
              />
            </button>
            <div
              v-else
              class="label-img__frame label-img__missing"
            >
              <i class="pi pi-image" />
              <span>{{ img.error }}</span>
              <code>{{ img.path }}</code>
            </div>
          </div>
          <Button
            v-tooltip.bottom="'Rotate'"
            icon="pi pi-replay"
            text
            rounded
            size="small"
            severity="secondary"
            class="rotate-btn"
            @click="labels.rotate(row.key)"
          />
        </div>

        <div class="label-row__body">
          <div class="label-row__head">
            <strong>{{ row.anonymizedName }}</strong>
            <span
              class="hint"
              :title="row.originalName"
            >← {{ row.originalName }}</span>
            <span
              class="badge"
              :class="statusClass(row)"
            >
              <i
                v-if="row.ocr === 'running'"
                class="pi pi-spin pi-spinner"
              />
              {{ row.ocr === 'running' ? 'Reading…' : row.ocr === 'queued' ? 'Queued' : statusLabel(row) }}
            </span>
          </div>
          <textarea
            class="label-text"
            rows="4"
            spellcheck="false"
            :value="row.text"
            :placeholder="row.ocr === 'running' ? 'Reading…' : 'Type the label text'"
            @input="labels.setText(row.key, ($event.target as HTMLTextAreaElement).value)"
          />
          <div
            v-if="row.ocrError"
            class="error-text"
          >
            OCR failed: {{ row.ocrError }}
          </div>
          <div class="label-row__actions">
            <label class="reviewed-check">
              <Checkbox
                :model-value="row.status === 'reviewed'"
                :binary="true"
                @update:model-value="labels.setReviewed(row.key, !!$event)"
              />
              Reviewed
            </label>
            <Button
              label="Read again"
              icon="pi pi-refresh"
              text
              size="small"
              :disabled="labels.ocrRunning || row.status === 'reviewed' || !row.images.some((i) => i.url)"
              @click="readAgain(row)"
            />
          </div>
        </div>
      </div>

      <template v-if="showNoLabel">
        <div
          v-for="row in labels.noLabelRows"
          :key="row.key"
          class="label-row label-row--none"
        >
          <div class="label-row__images">
            <div class="label-img__frame label-img__missing label-img__none">
              <i class="pi pi-ban" />
              <span>No label found in this slide</span>
            </div>
          </div>
          <div class="label-row__body">
            <div class="label-row__head">
              <strong>{{ row.anonymizedName }}</strong>
              <span
                class="hint"
                :title="row.originalName"
              >← {{ row.originalName }}</span>
              <span class="badge badge--queued">No label</span>
            </div>
            <p class="hint">
              No label found in this slide. The slide was renamed and its identifying
              metadata removed; there is no label text to read.
            </p>
          </div>
        </div>
      </template>
    </template>

    <div
      v-else-if="labels.dir && !labels.loading && !labels.error"
      class="empty-state"
    >
      No label images are listed in {{ labels.csvPath }}. Turn on “Keep the original label
      &amp; macro images” in step 1 to save them.
    </div>

    <Dialog
      :visible="!!zoomed"
      modal
      dismissable-mask
      :header="zoomed?.anonymizedName"
      :style="{ width: 'min(900px, 95vw)' }"
      @update:visible="zoomed = null"
    >
      <div
        v-if="zoomed"
        class="zoom"
      >
        <img
          v-for="img in zoomed.images.filter((i) => i.url)"
          :key="img.path"
          :src="img.url!"
          :alt="`Label of ${zoomed.anonymizedName}`"
          :style="rotatedStyle(zoomed.rotation, 'min(860px, 88vw)', '70vh')"
        />
        <div class="button-row">
          <Button
            label="Rotate"
            icon="pi pi-replay"
            outlined
            size="small"
            @click="labels.rotate(zoomed.key)"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.folder-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  align-items: center;
  margin-top: 12px;
}

.folder-summary select {
  margin-left: 6px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 6px;
}

.toolbar-card {
  position: sticky;
  top: 0;
  z-index: 5;
}

.filter-group {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.filter-btn {
  background: transparent;
  color: var(--text-dim);
  border: 0;
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.filter-btn + .filter-btn {
  border-left: 1px solid var(--border);
}

.filter-btn.active {
  background: var(--bg-elev-2);
  color: var(--text);
}

.label-row {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
  padding: 14px;
  margin-bottom: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.label-row--reviewed {
  border-color: rgba(46, 204, 113, 0.35);
}

.label-row__images {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.label-img__frame {
  width: 100%;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
  background: #0a0f18;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: zoom-in;
}

.label-img__frame img {
  object-fit: contain;
  transition: transform 0.15s ease;
}

.label-img__missing {
  flex-direction: column;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: default;
  text-align: center;
  padding: 10px;
}

.label-row--none {
  opacity: 0.85;
}

.label-img__none {
  height: 120px;
  font-size: 13px;
}

.rotate-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(14, 20, 32, 0.75) !important;
}

.label-row__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.label-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.label-row__head .hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}

.label-row__head .badge {
  margin-left: auto;
}

.label-text {
  width: 100%;
  resize: vertical;
  min-height: 92px;
  padding: 8px 10px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  font: 13px/1.45 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}

.label-text:focus {
  outline: 2px solid var(--accent);
  outline-offset: 0;
  border-color: var(--accent);
}

.label-row__actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.reviewed-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}

.zoom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.zoom {
  min-height: 300px;
  justify-content: center;
}

.zoom img {
  object-fit: contain;
}

@media (max-width: 720px) {
  .label-row {
    grid-template-columns: 1fr;
  }
}
</style>
