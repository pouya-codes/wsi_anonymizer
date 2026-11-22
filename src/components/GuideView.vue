<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import { currentView, openGuide, type AppView, type GuideSection } from '@/stores/nav';
import { LABELS_DIR, MACROS_DIR } from '@/stores/localAnon';
import { MAPPING_CSV_NAME } from '@/upload/mappingCsv';
import { WASM_ANON_EXTENSIONS } from '@/upload/wsiAnon';

const formats = [
  ...new Set([...WASM_ANON_EXTENSIONS].map((e) => (e === '.tif' ? 'TIFF' : e.slice(1).toUpperCase()))),
]
  .map((f) => (f === 'ISYNTAX' ? 'iSyntax' : f))
  .join(', ');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const toc: { id: GuideSection; label: string }[] = [
  { id: 'overview', label: 'How it works' },
  { id: 'before', label: 'Before you start' },
  { id: 'step1', label: 'Step 1 · Anonymize slides' },
  { id: 'output', label: 'The output folder' },
  { id: 'step2', label: 'Step 2 · Read labels' },
  { id: 'resume', label: 'Stop and continue later' },
  { id: 'share', label: 'Before you share' },
  { id: 'faq', label: 'Questions & problems' },
];

/** Highlight the section being read (scroll spy). */
const active = ref<GuideSection>('overview');
let observer: IntersectionObserver | null = null;
/** After a contents click, keep that entry lit while the page scrolls (the last
 *  sections can never reach the top of the window, so scroll spy alone misses them). */
let pinnedUntil = 0;

function jump(section: GuideSection): void {
  active.value = section;
  pinnedUntil = Date.now() + 1500;
  void openGuide(section);
}

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (Date.now() < pinnedUntil) return;
      const top = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) active.value = top.target.id.replace('guide-', '') as GuideSection;
    },
    { rootMargin: '0px 0px -70% 0px' }
  );
  for (const t of toc) {
    const el = document.getElementById(`guide-${t.id}`);
    if (el) observer.observe(el);
  }
});
onBeforeUnmount(() => observer?.disconnect());

function goTo(view: AppView): void {
  currentView.value = view;
  window.scrollTo({ top: 0 });
}

/** "Before you share" ticks — a reading aid only, not saved. */
const shareChecks = ref<boolean[]>([false, false, false, false, false]);

const mappingColumns: [string, string][] = [
  ['original_path', 'Where the slide came from (path inside what you added).'],
  ['anonymized_path', 'The anonymized copy in this folder, e.g. slide-0001.svs. Used to match rows — do not edit.'],
  ['original_filename / anonymized_filename', 'Just the file names.'],
  ['label_files / macro_files', `The saved original label / macro images in ${LABELS_DIR}/ and ${MACROS_DIR}/.`],
  ['anonymized_at / wsi_anon_version', 'When it was done and with which version of the scrubber.'],
  ['label_text', 'What the label says — filled in by step 2.'],
  ['label_status', 'Empty (not read), ocr (machine read, not checked), edited, reviewed, or none (the slide has no label).'],
  ['label_ocr_confidence', 'How sure the OCR was, 0–100.'],
  ['label_rotation', 'How far the label image was turned to be upright.'],
];
</script>

<template>
  <div class="guide">
    <div class="view-header">
      <div>
        <h1>How to use the Slide Anonymizer</h1>
        <p>
          A walk-through of both steps — anonymizing slides and recording what their
          labels said — plus what ends up in your folder and what to remove before
          you share it. About five minutes to read.
        </p>
      </div>
      <Button
        label="Start step 1"
        icon="pi pi-arrow-right"
        icon-pos="right"
        @click="goTo('anonymize')"
      />
    </div>

    <div class="guide-layout">
      <nav
        class="guide-toc"
        aria-label="Guide contents"
      >
        <a
          v-for="t in toc"
          :key="t.id"
          :href="`#guide-${t.id}`"
          :class="{ active: active === t.id }"
          @click.prevent="jump(t.id)"
        >{{ t.label }}</a>
      </nav>

      <div class="guide-body">
        <!-- OVERVIEW -->
        <section
          id="guide-overview"
          class="card guide-section"
        >
          <h2>How it works</h2>
          <p>
            Slide scanners store a photo of the glass slide's <strong>label</strong> (often
            the patient name, MRN or case number) and a <strong>macro</strong> overview
            image inside each slide file, along with identifying metadata. This tool makes
            copies of your slides with all of that removed, and keeps a private record so
            you can still trace each copy back to its source.
          </p>

          <ol class="flow">
            <li>
              <span class="flow__num">1</span>
              <i class="pi pi-shield" />
              <strong>Anonymize slides</strong>
              <span>Copies are scrubbed, renamed <code>slide-0001</code>… and saved to a folder you choose. The original label and macro are kept aside.</span>
            </li>
            <li>
              <span class="flow__num">2</span>
              <i class="pi pi-tag" />
              <strong>Read labels</strong>
              <span>OCR reads each kept label; you check and correct the text. It is saved next to the slide in a CSV.</span>
            </li>
            <li>
              <span class="flow__num">3</span>
              <i class="pi pi-send" />
              <strong>Share the slides</strong>
              <span>Share only the <code>slide-NNNN</code> files. Keep the labels, macros and CSV private.</span>
            </li>
          </ol>

          <div class="facts">
            <div>
              <i class="pi pi-desktop" />
              <span><strong>Runs on your computer.</strong> Slides are read and written by your browser. The page cannot send them anywhere, and the server has no way to receive them — it only counts how many slides are anonymized.</span>
            </div>
            <div>
              <i class="pi pi-copy" />
              <span><strong>Originals are never changed.</strong> Every result is a new file in the folder you choose.</span>
            </div>
            <div>
              <i class="pi pi-replay" />
              <span><strong>You can stop at any point.</strong> Progress is kept in the output folder, so you can come back days later.</span>
            </div>
          </div>
        </section>

        <!-- BEFORE -->
        <section
          id="guide-before"
          class="card guide-section"
        >
          <h2>Before you start</h2>
          <ul class="ticks">
            <li>
              <strong>Use Chrome or Edge on a desktop computer.</strong> They can save
              straight into a folder. Other browsers only offer each slide as a download
              (single-file slides up to 2 GB), and step 2 does not work there.
            </li>
            <li>
              <strong>Have an empty folder ready for the output</strong>, on a drive with
              room for a full copy of the slides. Never use the folder that holds the
              originals.
            </li>
            <li>
              <strong>Supported formats:</strong> {{ formats }}. For MRXS, add the
              whole folder so its data files come along. Label and macro images can be kept for
              SVS, NDPI, BIF, TIFF and iSyntax.
            </li>
            <li>
              <strong>Keep this tab open</strong> while slides are being saved or labels are
              being read. Large slides take a while — the work happens on your computer.
            </li>
          </ul>
        </section>

        <!-- STEP 1 -->
        <section
          id="guide-step1"
          class="card guide-section"
        >
          <div class="row-between">
            <h2>Step 1 · Anonymize slides</h2>
            <Button
              label="Go to step 1"
              icon="pi pi-arrow-right"
              icon-pos="right"
              size="small"
              outlined
              @click="goTo('anonymize')"
            />
          </div>
          <p>The step 1 page has four boxes. Work through them top to bottom.</p>

          <ol class="walk">
            <li>
              <h3>1 · Slides — add what you want to anonymize</h3>
              <p>
                Drag slides or whole folders onto the drop area, or use
                <span class="ui">Add files</span> / <span class="ui">Add folder</span>. Each
                slide becomes a row showing its name, the name it will be saved as, and its
                size. Files that are not slides are skipped, and
                <i class="pi pi-times" /> removes a row.
              </p>
            </li>
            <li>
              <h3>2 · Save to — choose the output folder</h3>
              <p>
                Click <span class="ui">Choose output folder</span> and pick your empty
                folder. The browser asks whether this site may edit files there — choose
                <strong>Allow / Edit files</strong>. You can also pick a folder you used
                before: numbering continues after the slides already in it.
              </p>
            </li>
            <li>
              <h3>3 · Anonymization — check the options</h3>
              <table class="guide-table">
                <thead>
                  <tr>
                    <th>Option</th>
                    <th>Default</th>
                    <th>What it does</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Label / macro / metadata scrub</td>
                    <td>Always on</td>
                    <td>Removes the label and macro images and identifying metadata from each copy.</td>
                  </tr>
                  <tr>
                    <td>Sanitize filenames to slide-NNNN</td>
                    <td>On</td>
                    <td>Renames copies to <code>slide-0001.svs</code>, <code>slide-0002.ndpi</code>… so file names cannot reveal the patient.</td>
                  </tr>
                  <tr>
                    <td>Drop source folder names</td>
                    <td>On</td>
                    <td>Puts every slide at the top of the output folder instead of recreating folders like <code>Smith_John/</code>.</td>
                  </tr>
                  <tr>
                    <td>Start numbering at</td>
                    <td>Next free number</td>
                    <td>Change it if you need the numbers to continue from another batch.</td>
                  </tr>
                  <tr>
                    <td>Keep the original label &amp; macro images</td>
                    <td>On</td>
                    <td>Saves the untouched images into <code>{{ LABELS_DIR }}/</code> and <code>{{ MACROS_DIR }}/</code> first. <strong>Leave this on if you want to do step 2.</strong></td>
                  </tr>
                  <tr>
                    <td>I understand residual re-identification risk</td>
                    <td>Must tick</td>
                    <td>The tissue itself is not changed; rare findings can still identify someone.</td>
                  </tr>
                </tbody>
              </table>
              <p class="hint">
                If you turn renaming off, you must also confirm the original file names
                contain no patient name, MRN, accession number or date of birth.
              </p>
            </li>
            <li>
              <h3>4 · Run — start and watch</h3>
              <p>
                Click <span class="ui">Anonymize &amp; save</span>. If the button is greyed
                out, the list above it says what is still missing. Each row moves through
              </p>
              <div class="badge-flow">
                <span class="badge badge--queued">Queued</span>
                <i class="pi pi-angle-right" />
                <span class="badge badge--importing">Saving label</span>
                <i class="pi pi-angle-right" />
                <span class="badge badge--importing">Scrubbing</span>
                <i class="pi pi-angle-right" />
                <span class="badge badge--importing">Saving</span>
                <i class="pi pi-angle-right" />
                <span class="badge badge--done">Saved</span>
              </div>
              <p>
                <span class="ui">Cancel</span> stops the batch; slides already marked Saved
                stay saved. If any row ends as <span class="badge badge--failed">Failed</span>,
                its error is shown under it and <span class="ui">Retry remaining</span> runs
                just the unfinished ones. When the batch is done, click
                <span class="ui">Next: read labels</span>.
              </p>
              <p class="hint">
                If files with the same names already exist in the folder, you are asked
                before anything is replaced.
              </p>
            </li>
          </ol>
        </section>

        <!-- OUTPUT -->
        <section
          id="guide-output"
          class="card guide-section"
        >
          <h2>The output folder</h2>
          <p>After step 1 your folder looks like this:</p>
          <pre class="tree"><span class="tree__dir">my-output/</span>
├── slide-0001.svs                 <span class="tree__ok">anonymized — safe to share</span>
├── slide-0002.ndpi                <span class="tree__ok">anonymized — safe to share</span>
├── {{ MAPPING_CSV_NAME.padEnd(31) }}<span class="tree__phi">private — links slides to patients</span>
├── <span class="tree__dir">{{ LABELS_DIR }}/</span>
│   ├── slide-0001_label.png       <span class="tree__phi">private — original label</span>
│   └── slide-0002_label.jpg
└── <span class="tree__dir">{{ MACROS_DIR }}/</span>
    ├── slide-0001_macro.jpg       <span class="tree__phi">private — original overview</span>
    └── slide-0002_macro.jpg</pre>
          <p>
            <code>{{ MAPPING_CSV_NAME }}</code> is written automatically after every slide
            and opens in Excel. It has one row per anonymized slide; later batches into the
            same folder add rows to it. Step 2 fills in the label columns.
          </p>
          <details class="more">
            <summary>What each column means</summary>
            <table class="guide-table">
              <tbody>
                <tr
                  v-for="[col, desc] in mappingColumns"
                  :key="col"
                >
                  <td><code>{{ col }}</code></td>
                  <td>{{ desc }}</td>
                </tr>
              </tbody>
            </table>
          </details>
          <p class="hint">
            The <span class="ui">Download CSV</span> / <span class="ui">Download JSON</span>
            buttons on step 1 give a copy of the current batch's mapping, e.g. if the folder
            could not be written to.
          </p>
        </section>

        <!-- STEP 2 -->
        <section
          id="guide-step2"
          class="card guide-section"
        >
          <div class="row-between">
            <h2>Step 2 · Read labels</h2>
            <Button
              label="Go to step 2"
              icon="pi pi-arrow-right"
              icon-pos="right"
              size="small"
              outlined
              @click="goTo('labels')"
            />
          </div>
          <p>
            Records what each original label says (patient, case or block IDs) next to its
            anonymized slide — for your own records, never for sharing.
          </p>

          <ol class="walk">
            <li>
              <h3>Open the output folder</h3>
              <p>
                Right after step 1, click <span class="ui">Use “my-output”</span>. Otherwise
                click <span class="ui">Open output folder</span> and pick the folder step 1
                saved into, then allow access. Every saved label appears as a row: the label
                image on the left, a text box on the right.
              </p>
            </li>
            <li>
              <h3>Let OCR fill in the text</h3>
              <p>
                Click <span class="ui">Read N label(s) with OCR</span>. The first time, the
                reader (about 7 MB) downloads to your browser; after that each label takes a
                second or two. Labels stored sideways or upside down are turned automatically.
                OCR only fills labels that are still empty, never text you typed, and saves
                its results by itself. <span class="ui">Stop OCR</span> stops at any point.
              </p>
            </li>
            <li>
              <h3>Check every label</h3>
              <div class="mock-row">
                <div class="mock-row__img">
                  <span>S24-1234 A1</span>
                  <span>H&amp;E</span>
                  <i class="pi pi-replay mock-row__rotate" />
                </div>
                <div class="mock-row__body">
                  <div class="mock-row__head">
                    <strong>slide-0001.svs</strong>
                    <span class="hint">← case14/S24-1234_A1.svs</span>
                    <span class="badge badge--importing">OCR · 91%</span>
                  </div>
                  <div class="mock-row__text">S24-1234 Al<br />H&amp;E</div>
                  <div class="mock-row__actions">
                    <span><i class="pi pi-stop" /> Reviewed</span>
                    <span class="mock-link"><i class="pi pi-refresh" /> Read again</span>
                  </div>
                </div>
              </div>
              <ul class="ticks">
                <li>Compare the text with the image. Click the image to enlarge it; <i class="pi pi-replay" /> turns it.</li>
                <li>Correct the text box — above, OCR read <code>A1</code> as <code>Al</code>. Typing marks the label <em>Edited</em>.</li>
                <li>Tick <span class="ui">Reviewed</span> once it is right. Reviewed labels are never changed by OCR.</li>
                <li><span class="ui">Read again</span> re-runs OCR on one label (it asks before replacing text you typed).</li>
                <li>Use <span class="ui">To review</span> at the top to see only the labels you have not finished.</li>
              </ul>
            </li>
            <li>
              <h3>Save</h3>
              <p>
                Click <span class="ui">Save</span> or press
                <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd>+<kbd>S</kbd>. The toolbar shows how many
                labels are unsaved, and the step 2 tab shows an orange dot. The browser warns
                you if you try to leave with unsaved text.
              </p>
            </li>
          </ol>

          <h3 class="subhead">What the badges mean</h3>
          <div class="legend">
            <span class="badge badge--queued">Not read</span><span>No text yet.</span>
            <span class="badge badge--importing">OCR · 91%</span><span>Read by OCR, fairly confident — still check it.</span>
            <span class="badge badge--cancelled">OCR · 48%</span><span>Read by OCR, not confident — check carefully.</span>
            <span class="badge badge--uploaded">Edited</span><span>You changed the text.</span>
            <span class="badge badge--done">Reviewed</span><span>You confirmed it is correct.</span>
          </div>

          <div class="banner banner--info tip">
            <i class="pi pi-info-circle" />
            <span>
              OCR is good with printed and typed labels. <strong>Handwriting is usually read
              poorly or not at all</strong> — type those in. Barcodes and logos are ignored.
              Watch for look-alike characters: 0/O, 1/l/I, 5/S, 8/B.
            </span>
          </div>
        </section>

        <!-- RESUME -->
        <section
          id="guide-resume"
          class="card guide-section"
        >
          <h2>Stop and continue later</h2>
          <p>
            Everything is saved in <code>{{ MAPPING_CSV_NAME }}</code> inside the output
            folder — there is nothing to export or remember.
          </p>
          <ul class="ticks">
            <li>
              <strong>To continue reading labels:</strong> open step 2, click
              <span class="ui">Open output folder</span> and pick the same folder. Text,
              status and rotation come back as you left them; choose
              <span class="ui">To review</span> to pick up where you stopped.
            </li>
            <li>
              <strong>To add more slides:</strong> run step 1 again into the same folder.
              Numbering continues, new rows are added to the CSV and label text you already
              entered is kept. If the label list is open, the new labels appear in it.
            </li>
            <li>
              <strong>Opening the CSV in Excel is fine</strong> — columns you add are kept.
              Close it in Excel before saving in step 2 (Excel locks the file), keep the
              CSV format if you save from Excel, and do not change
              <code>anonymized_path</code>.
            </li>
            <li>
              Your browser may ask again for permission to the folder each time you come back.
            </li>
          </ul>
        </section>

        <!-- SHARE -->
        <section
          id="guide-share"
          class="card guide-section"
        >
          <h2>Before you share</h2>
          <p>Tick through this list each time you hand slides to someone else.</p>
          <ul class="checklist">
            <li>
              <label>
                <input
                  v-model="shareChecks[0]"
                  type="checkbox"
                />
                <span>Share only the <code>slide-NNNN</code> files (copy them to a new folder, or a new drive).</span>
              </label>
            </li>
            <li>
              <label>
                <input
                  v-model="shareChecks[1]"
                  type="checkbox"
                />
                <span>The <code>{{ LABELS_DIR }}/</code> and <code>{{ MACROS_DIR }}/</code> folders are <strong>not</strong> included.</span>
              </label>
            </li>
            <li>
              <label>
                <input
                  v-model="shareChecks[2]"
                  type="checkbox"
                />
                <span><code>{{ MAPPING_CSV_NAME }}</code> is <strong>not</strong> included — store it securely; it is the only link back to the patients.</span>
              </label>
            </li>
            <li>
              <label>
                <input
                  v-model="shareChecks[3]"
                  type="checkbox"
                />
                <span>If you kept original file or folder names, they contain no identifiers.</span>
              </label>
            </li>
            <li>
              <label>
                <input
                  v-model="shareChecks[4]"
                  type="checkbox"
                />
                <span>You opened a slide or two in a viewer and saw no label or macro image.</span>
              </label>
            </li>
          </ul>
          <div
            v-if="shareChecks.every(Boolean)"
            class="banner banner--success"
          >
            <i class="pi pi-check" /> Ready to share. Remember the tissue itself can still be distinctive.
          </div>
        </section>

        <!-- FAQ -->
        <section
          id="guide-faq"
          class="card guide-section"
        >
          <h2>Questions &amp; problems</h2>
          <details class="faq">
            <summary>There is no “Choose output folder” button — only downloads.</summary>
            <p>Your browser cannot write into folders. Open this site in Chrome or Edge on a desktop computer.</p>
          </details>
          <details class="faq">
            <summary>A slide says “no label in slide” under Label / macro.</summary>
            <p>
              The slide file has no label or macro image (some scanners and many public
              datasets do not store one). It is still processed: it is renamed and its
              identifying metadata (file name, title, scanner ID, user, date and time) is
              removed. In step 2 it is listed as “No label found in this slide”.
            </p>
          </details>
          <details class="faq">
            <summary>A slide says “none saved” under Label / macro.</summary>
            <p>
              The tool could not read a label or macro image from that slide (MRXS is not
              supported for this yet). The slide itself is still scrubbed and saved. You can
              type its label text in by hand from the glass slide.
            </p>
          </details>
          <details class="faq">
            <summary>A label shows “This image format cannot be read in the browser”.</summary>
            <p>
              Some scanners store the label as TIFF, which browsers cannot display. Open the
              file from the <code>{{ LABELS_DIR }}/</code> folder in another program and type the
              text into the box.
            </p>
          </details>
          <details class="faq">
            <summary>Step 2 says “Could not save”.</summary>
            <p>
              The CSV is usually open in Excel, which locks it. Close it there and click
              <span class="ui">Save</span> again — your text stays on screen until it is saved.
            </p>
          </details>
          <details class="faq">
            <summary>OCR produced nonsense, or nothing.</summary>
            <p>
              Usually handwriting, a faint print or a very small label. Type the text in. If
              the image looks sideways, turn it with <i class="pi pi-replay" /> and click
              <span class="ui">Read again</span>.
            </p>
          </details>
          <details class="faq">
            <summary>Step 2 says “No anonymization-mapping.csv in this folder”.</summary>
            <p>
              Pick the folder step 1 saved into — the one that contains
              <code>{{ MAPPING_CSV_NAME }}</code> and <code>{{ LABELS_DIR }}/</code>, not a
              folder inside it.
            </p>
          </details>
          <details class="faq">
            <summary>Does anything leave my computer?</summary>
            <p>
              Your slides, labels, label text and file names never do. The page is only
              allowed to talk to this website, and this website has no way to receive files.
              The one thing it records is a count: for each slide you anonymize, its size and
              format are logged under the access password you signed in with, so usage per
              department can be reported. The OCR reader is downloaded from this site once.
            </p>
          </details>
          <details class="faq">
            <summary>I closed the tab in the middle of a batch.</summary>
            <p>
              Slides marked Saved are complete and listed in the CSV. Add only the slides
              that were not finished, choose the same folder and run again — numbering
              continues after the saved ones. If an unfinished file (or a
              <code>.crswap</code> file) was left in the folder, delete it; it is not listed
              in the CSV.
            </p>
          </details>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide-layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

.guide-toc {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 1px solid var(--border);
}

.guide-toc a {
  padding: 6px 12px;
  margin-left: -1px;
  border-left: 2px solid transparent;
  color: var(--text-dim);
  text-decoration: none;
  font-size: 13px;
}

.guide-toc a:hover {
  color: var(--text);
}

.guide-toc a.active {
  color: var(--text);
  border-left-color: var(--accent);
}

.guide-section {
  padding: 20px 22px;
  scroll-margin-top: 16px;
  line-height: 1.55;
}

.guide-section h2 {
  margin: 0 0 10px;
  font-size: 17px;
}

.guide-section p {
  margin: 0 0 10px;
  max-width: 75ch;
}

.guide-section .row-between {
  margin-bottom: 4px;
}

.subhead {
  margin: 18px 0 10px;
  font-size: 14px;
}

.ui {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev-2);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}

kbd {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg);
  font: 12px ui-monospace, Menlo, Consolas, monospace;
}

/* -- Overview flow -- */
.flow {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 0;
  margin: 16px 0;
  list-style: none;
  counter-reset: none;
}

.flow li {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-dim);
}

.flow li strong {
  color: var(--text);
  font-size: 14px;
}

.flow li > .pi {
  color: var(--accent);
  font-size: 18px;
}

.flow li + li::before {
  content: '\2192';
  position: absolute;
  left: -11px;
  top: 50%;
  transform: translate(-50%, -50%);
  color: var(--text-dim);
}

.flow__num {
  position: absolute;
  top: 12px;
  right: 12px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
}

.facts {
  display: grid;
  gap: 8px;
}

.facts > div {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
}

.facts .pi {
  color: var(--accent-2);
}

/* -- Lists -- */
.ticks {
  margin: 0 0 10px;
  padding-left: 20px;
}

.ticks li {
  margin-bottom: 8px;
}

.walk {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  counter-reset: walk;
}

.walk > li {
  position: relative;
  padding: 0 0 16px 38px;
  counter-increment: walk;
}

.walk > li::before {
  content: counter(walk);
  position: absolute;
  left: 0;
  top: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent);
  color: #06101c;
  font-size: 12px;
  font-weight: 700;
}

.walk > li:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 11px;
  top: 30px;
  bottom: 6px;
  width: 2px;
  background: var(--border);
}

.walk h3 {
  margin: 2px 0 6px;
  font-size: 14px;
}

.guide-table {
  width: 100%;
  margin: 6px 0 10px;
  border-collapse: collapse;
  font-size: 13px;
}

.guide-table th,
.guide-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.guide-table th {
  color: var(--text-dim);
  font-weight: 600;
  font-size: 12px;
}

.guide-table td:first-child {
  white-space: nowrap;
  font-weight: 600;
}

.badge-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 4px 0 12px;
}

.badge-flow .pi {
  color: var(--text-dim);
  font-size: 12px;
}

/* -- Output tree -- */
.tree {
  margin: 0 0 12px;
  padding: 14px 16px;
  overflow-x: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font: 12.5px/1.6 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}

.tree__dir {
  color: var(--accent);
}

.tree__ok {
  color: var(--accent-2);
}

.tree__phi {
  color: var(--warn);
}

.more,
.faq {
  margin: 0 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.more > summary,
.faq > summary {
  padding: 10px 14px;
  cursor: pointer;
  font-weight: 600;
}

.more[open] > summary,
.faq[open] > summary {
  border-bottom: 1px solid var(--border);
}

.more > table {
  margin: 0;
}

.faq > p {
  margin: 0;
  padding: 10px 14px 12px;
}

/* -- Mock label row -- */
.mock-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
  margin: 6px 0 12px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.mock-row__img {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 10px 12px;
  background: #f4f1ea;
  color: #1a1a1a;
  border-radius: 6px;
  font: 600 13px/1.3 Arial, sans-serif;
}

.mock-row__rotate {
  position: absolute;
  top: 6px;
  right: 6px;
  color: #6b7280;
  font-size: 11px;
}

.mock-row__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.mock-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 13px;
}

.mock-row__head .badge {
  margin-left: auto;
}

.mock-row__text {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font: 12.5px/1.45 ui-monospace, Menlo, Consolas, monospace;
}

.mock-row__actions {
  display: flex;
  gap: 16px;
  font-size: 12.5px;
}

.mock-link {
  color: var(--accent);
}

.legend {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 14px;
  align-items: center;
  margin-bottom: 14px;
  font-size: 13px;
}

.legend .badge {
  justify-self: start;
}

.tip {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin: 0;
}

/* -- Share checklist -- */
.checklist {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}

.checklist li + li {
  margin-top: 8px;
}

.checklist label {
  display: flex;
  gap: 10px;
  align-items: baseline;
  cursor: pointer;
}

.checklist input {
  accent-color: var(--accent-2);
  transform: translateY(2px);
}

@media (max-width: 860px) {
  .guide-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .guide-toc {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    border-left: 0;
  }

  .guide-toc a {
    border-left: 0;
    border-bottom: 2px solid transparent;
  }

  .guide-toc a.active {
    border-bottom-color: var(--accent);
  }

  .flow {
    grid-template-columns: minmax(0, 1fr);
  }

  .flow li + li::before {
    content: none;
  }

  .mock-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .guide-table td:first-child {
    white-space: normal;
  }

  .view-header {
    flex-direction: column;
  }
}
</style>
