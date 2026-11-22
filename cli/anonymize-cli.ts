/**
 * Slide Anonymizer — command-line version.
 *
 * Same anonymization as the web app (EMPAIA WSI-anon +
 * our Aperio metadata scrub), for whole folders of slides at once.
 *
 *   slide-anonymizer                       ask for the folders (double-click)
 *   slide-anonymizer <input> [output]      run directly (or drag a folder onto it)
 *
 * Output folder layout matches the web tool, so its "Read labels" step can be
 * used on it afterwards:
 *   slide-0001.svs …                       anonymized slides (share these)
 *   anonymization-mapping.csv              original ↔ new names (keep private)
 *   labels/, macros/                       original label / macro images (--keep-labels; keep private)
 *
 * Re-running on the same folders skips slides already done, so a long run can
 * be stopped and continued.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import process from 'node:process';
import type { LocalFile, LocalFileset } from '@/types';
import { anonymizeLocalFiles, slideNumberOf } from '@/upload/anonymizeNames';
import {
  extractAssociatedImages,
  planMetadataScrub,
  setRawPngEncoder,
  type MetadataScrubPlan,
} from '@/upload/associatedImages';
import { groupFilesets } from '@/upload/filesets';
import {
  MAPPING_COLUMNS,
  MAPPING_CSV_NAME,
  parseMappingTable,
  serializeMappingTable,
  type MappingRecord,
  type MappingTable,
} from '@/upload/mappingCsv';
import {
  anonymizeFilesetWasm,
  destroyAnonSources,
  plainSource,
  WASM_ANON_EXTENSIONS,
  withByteEdits,
  wsiAnonVersion,
  type AnonymizedChunkSource,
} from '@/upload/wsiAnon';
import { toCsv } from '@/utils/csv';
import { DiskFile } from './diskFile';
import { encodePng } from './png';

setRawPngEncoder(encodePng);

const VERSION = '1.0.0';
const LABELS_DIR = 'labels';
const MACROS_DIR = 'macros';
const FAILED_CSV = 'anonymization-failed.csv';
const WRITE_CHUNK = 16 * 1024 * 1024;

/* --------------------------------- Options -------------------------------- */

interface Options {
  input: string | null;
  output: string | null;
  keepNames: boolean;
  keepLabels: boolean;
  startAt: number | null;
  yes: boolean;
}

const HELP = `Slide Anonymizer ${VERSION} — removes slide labels, macro images and identifying
metadata from whole-slide images (SVS, NDPI, MRXS, BIF, TIFF, iSyntax).
Originals are never changed.

Usage:
  slide-anonymizer                         asks for the folders
  slide-anonymizer <input> [output]        anonymize every slide under <input>

Options:
  --keep-names     keep the original file names (default: slide-0001, slide-0002, ...)
  --keep-labels    also save the original label and macro images (patient information!)
                   to labels/ and macros/ in the output folder
  --start <N>      first slide number (default: continue after what is in the output folder)
  --yes, -y        do not ask any questions
  --help, -h       show this help

The default output folder is "<input> (anonymized)" next to the input folder.
Run it again on the same folders to continue an interrupted run.`;

function parseArgs(argv: string[]): Options {
  const o: Options = { input: null, output: null, keepNames: false, keepLabels: false, startAt: null, yes: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (a === '--keep-names') o.keepNames = true;
    else if (a === '--keep-labels') o.keepLabels = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--start') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) fail('--start needs a whole number, 1 or more');
      o.startAt = n;
    } else if (a.startsWith('-')) fail(`Unknown option ${a} (see --help)`);
    else positional.push(a);
  }
  if (positional.length > 2) fail('Give at most two folders: input and output (see --help)');
  o.input = positional[0] ?? null;
  o.output = positional[1] ?? null;
  return o;
}

function fail(message: string): never {
  console.error(`\nError: ${message}`);
  process.exit(2);
}

/* ------------------------------- Questions -------------------------------- */

const interactive = Boolean(process.stdin.isTTY);
let rl: readline.Interface | null = null;

function ask(question: string): Promise<string> {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl!.question(question, resolve));
}

/** A path typed or dragged into the terminal (quotes, macOS backslash escapes). */
function cleanDroppedPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('& ')) p = p.slice(2).trim(); // PowerShell drag & drop
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
  if (process.platform !== 'win32') p = p.replace(/\\(.)/g, '$1');
  return p;
}

async function waitBeforeClosing(): Promise<void> {
  if (interactive) await ask('\nPress Enter to close this window.');
}

/* --------------------------------- Files ---------------------------------- */

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** Every file under `root` (skipping hidden files and the output folder). */
function walk(root: string, skipDir: string | null): LocalFile[] {
  const out: LocalFile[] = [];
  const stack = [root];
  const seenDirs = new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    if (skipDir && path.resolve(dir) === skipDir) continue;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue; // linked folders that loop back
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`  Cannot read folder ${dir}: ${(err as Error).message}`);
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken link
        }
      }
      if (isDir) stack.push(full);
      else if (isFile) {
        const rel = toPosix(path.relative(root, full));
        const file = DiskFile.open(full, e.name);
        out.push({ path: rel, size: file.size, file: file.asFile() });
      }
    }
  }
  return out;
}

function closeFiles(fileset: LocalFileset): void {
  for (const m of fileset.files) (m.file as unknown as DiskFile).close();
}

/** Write a chunk source to disk via a temporary name, so a crash never leaves a half file. */
async function writeSource(outRoot: string, rel: string, src: AnonymizedChunkSource): Promise<void> {
  const dest = path.join(outRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const fd = fs.openSync(tmp, 'w');
  try {
    for (let at = 0; at < src.size; at += WRITE_CHUNK) {
      const blob = await src.getChunk(at, Math.min(WRITE_CHUNK, src.size - at));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let done = 0;
      while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
}

function writeFileAtomic(dest: string, data: string | Uint8Array): void {
  const tmp = `${dest}.partial`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
}

function existsRel(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, ...rel.split('/')));
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.ceil(n / 1e3)} KB`;
}

function formatTime(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/* ------------------------------ Mapping CSV ------------------------------- */

function readMapping(outRoot: string): MappingTable {
  const p = path.join(outRoot, MAPPING_CSV_NAME);
  if (!fs.existsSync(p)) return { path: MAPPING_CSV_NAME, columns: [...MAPPING_COLUMNS], records: [] };
  const table = parseMappingTable(MAPPING_CSV_NAME, fs.readFileSync(p, 'utf8'));
  if (!table) fail(`${p} is not an anonymization mapping file. Choose another output folder.`);
  return table;
}

function saveMapping(outRoot: string, table: MappingTable): void {
  writeFileAtomic(path.join(outRoot, MAPPING_CSV_NAME), serializeMappingTable(table));
}

/* ------------------------- Console noise from WASM ------------------------ */

/** WSI-anon prints progress on stdout and its reason for failing on stderr. */
const wasmMessages: string[] = [];
const realLog = console.log.bind(console);
const realError = console.error.bind(console);
const realWarn = console.warn.bind(console);
let quiet = false;
function muteWasm(on: boolean): void {
  quiet = on;
  if (on) wasmMessages.length = 0;
}
/** WSI-anon logs these for every chunk read; never show them. */
const WASM_CHATTER = /^(Applying changes\.\.\.|Anonymize .*\.\.\.)$/;
console.log = (...args: unknown[]) => {
  if (quiet || (args.length === 1 && WASM_CHATTER.test(String(args[0])))) return;
  realLog(...args);
};
console.error = (...args: unknown[]) => {
  if (quiet) wasmMessages.push(args.map(String).join(' ').trim());
  else realError(...args);
};
console.warn = (...args: unknown[]) => {
  if (quiet) wasmMessages.push(args.map(String).join(' ').trim());
  else realWarn(...args);
};
const say = (s = '') => realLog(s);

/* ---------------------------------- Main ---------------------------------- */

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  say(`Slide Anonymizer ${VERSION} (command line) — cPathPortal / AIM Lab`);
  say('Removes slide labels, macro images and identifying metadata. Originals are not changed.\n');

  const askedForFolders = !opts.input;
  if (!opts.input) {
    if (!interactive) fail('No input folder given (see --help)');
    opts.input = cleanDroppedPath(await ask('Drag the folder with your slides into this window, then press Enter:\n> '));
  }
  const input = path.resolve(cleanDroppedPath(opts.input));
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) fail(`Input folder not found: ${input}`);

  let output = opts.output ? path.resolve(cleanDroppedPath(opts.output)) : `${input} (anonymized)`;
  if (askedForFolders && !opts.output) {
    const answer = cleanDroppedPath(
      await ask(`\nWhere should the anonymized copies go?\nPress Enter for:  ${output}\nor drag another folder here:\n> `)
    );
    if (answer) output = path.resolve(answer);
  }
  if (path.resolve(output) === input) fail('The output folder must be different from the input folder.');

  if (askedForFolders && !opts.keepLabels && !opts.yes) {
    const a = (await ask('\nAlso keep a copy of the original labels (they contain patient information)? [y/N] ')).trim();
    opts.keepLabels = /^y(es)?$/i.test(a);
  }

  fs.mkdirSync(output, { recursive: true });
  const outRoot = path.resolve(output);

  say(`\nInput : ${input}\nOutput: ${outRoot}\nNames : ${opts.keepNames ? 'kept as they are' : 'slide-0001, slide-0002, ...'}`);
  say(`Labels: ${opts.keepLabels ? `original labels saved to ${LABELS_DIR}/ and ${MACROS_DIR}/` : 'removed, no copy kept'}`);

  say('\nLooking for slides...');
  const files = walk(input, outRoot.startsWith(input + path.sep) ? outRoot : null);
  const { filesets, skipped } = groupFilesets(files, [...WASM_ANON_EXTENSIONS]);
  const table = readMapping(outRoot);
  const doneOriginals = new Set(
    table.records.filter((r) => r.anonymized_path && existsRel(outRoot, r.anonymized_path)).map((r) => r.original_path)
  );
  const todo = filesets.filter((f) => !doneOriginals.has(f.main));
  const totalBytes = todo.reduce((s, f) => s + f.size, 0);
  say(
    `Found ${filesets.length} slide(s)` +
      (filesets.length - todo.length ? `, ${filesets.length - todo.length} already done` : '') +
      `${skipped.length ? `, ${skipped.length} other file(s) ignored` : ''}.`
  );
  if (!todo.length) {
    say('Nothing to do.');
    await waitBeforeClosing();
    return 0;
  }
  say(`To anonymize: ${todo.length} slide(s), ${formatBytes(totalBytes)}.`);

  if (interactive && !opts.yes) {
    const a = (await ask('\nStart? [Y/n] ')).trim();
    if (/^n(o)?$/i.test(a)) return 0;
  }

  // Slide numbers continue after what the output folder / mapping already uses.
  let startAt = opts.startAt ?? 1;
  if (opts.startAt == null) {
    let max = 0;
    for (const r of table.records) max = Math.max(max, slideNumberOf(path.posix.basename(r.anonymized_path ?? '')) ?? 0);
    for (const name of fs.readdirSync(outRoot)) max = Math.max(max, slideNumberOf(name.replace(/^_(slide-\d+)_$/, '$1')) ?? 0);
    startAt = max + 1;
  }
  const names = opts.keepNames
    ? null
    : anonymizeLocalFiles(files, todo, { startAt, dropParentDirs: true });
  // anonymizeLocalFiles keeps the order of `files`, so index i is the same file.
  const renamed = new Map<string, string>();
  if (names) for (let i = 0; i < files.length; i++) renamed.set(files[i].path, names.files[i].path);

  const version = await wsiAnonVersion();
  const failed: string[][] = [];
  const started = Date.now();
  let bytesDone = 0;
  let ok = 0;

  for (const [i, fileset] of todo.entries()) {
    const outMain = renamed.get(fileset.main) ?? fileset.main;
    const tag = `[${i + 1}/${todo.length}]`;
    process.stdout.write(`${tag} ${fileset.main} → ${outMain} (${formatBytes(fileset.size)}) ... `);
    const t0 = Date.now();
    let sources: Record<string, AnonymizedChunkSource> = {};
    const savedAssociated: string[] = [];
    const notes: string[] = [];
    try {
      const outMembers = fileset.files.map((m) => renamed.get(m.path) ?? m.path);
      if (opts.keepNames && outMembers.some((p) => existsRel(outRoot, p))) {
        throw new Error('a file with this name already exists in the output folder');
      }

      // 1. Optional copy of the original label / macro.
      let noLabel = false;
      if (opts.keepLabels) {
        const { images, complete } = await extractAssociatedImages(fileset);
        noLabel = complete && !images.some((img) => img.kind === 'label');
        const used = new Map<string, number>();
        for (const img of images) {
          const base = `${img.kind === 'label' ? LABELS_DIR : MACROS_DIR}/${outMain.replace(/\.[^./]+$/, '')}_${img.kind}`;
          const n = (used.get(base) ?? 0) + 1;
          used.set(base, n);
          const rel = `${base}${n > 1 ? `-${n}` : ''}.${img.ext}`;
          const dest = path.join(outRoot, ...rel.split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          writeFileAtomic(dest, new Uint8Array(await img.blob.arrayBuffer()));
          savedAssociated.push(rel);
        }
      }

      // 2. Scrub (WSI-anon + our Aperio metadata scrub; fallback for slides without label/macro).
      let plan: MetadataScrubPlan | null = null;
      try {
        plan = await planMetadataScrub(fileset);
      } catch {
        plan = null;
      }
      if (plan && !plan.hasLabel) noLabel = true;
      muteWasm(true);
      try {
        sources = await anonymizeFilesetWasm(fileset, { keyPrefix: 'cli/' });
        if (plan?.edits.length && sources[fileset.main]) {
          sources[fileset.main] = withByteEdits(sources[fileset.main], plan.edits);
        }
      } catch (err) {
        const main = fileset.files.find((f) => f.path === fileset.main);
        if (!plan || plan.hasLabel || plan.hasMacro || !main) {
          const reason = wasmMessages.filter(Boolean).join(' ').replace(/^Error:\s*/, '');
          throw new Error(reason || (err as Error).message);
        }
        sources = { [fileset.main]: withByteEdits(plainSource(fileset.main, main.file), plan.edits) };
        notes.push('no label or macro in slide: metadata removed');
      } finally {
        muteWasm(false);
      }

      // 3. Write every member of the fileset.
      for (const m of fileset.files) {
        const src = sources[m.path] ?? plainSource(m.path, m.file);
        await writeSource(outRoot, renamed.get(m.path) ?? m.path, src);
      }

      // 4. Record it (after the slide is safely on disk).
      const rec: MappingRecord = {
        original_path: fileset.main,
        anonymized_path: outMain,
        original_filename: path.posix.basename(fileset.main),
        anonymized_filename: path.posix.basename(outMain),
        label_files: savedAssociated.filter((p) => p.startsWith(`${LABELS_DIR}/`)).join(';'),
        macro_files: savedAssociated.filter((p) => p.startsWith(`${MACROS_DIR}/`)).join(';'),
        anonymized_at: new Date().toISOString(),
        wsi_anon_version: version,
        label_text: '',
        label_status: noLabel ? 'none' : '',
        label_ocr_confidence: '',
        label_rotation: '',
      };
      const at = table.records.findIndex((r) => r.anonymized_path === outMain);
      if (at >= 0) table.records[at] = { ...table.records[at], ...rec };
      else table.records.push(rec);
      saveMapping(outRoot, table);

      ok++;
      bytesDone += fileset.size;
      const rate = bytesDone / Math.max(1, (Date.now() - started) / 1000);
      const left = todo.slice(i + 1).reduce((s, f) => s + f.size, 0) / rate;
      say(`done (${formatTime((Date.now() - t0) / 1000)}${notes.length ? `; ${notes.join('; ')}` : ''})` + (i + 1 < todo.length ? ` — about ${formatTime(left)} left` : ''));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(`FAILED: ${message}`);
      failed.push([fileset.main, message]);
      for (const rel of savedAssociated) fs.rmSync(path.join(outRoot, ...rel.split('/')), { force: true });
    } finally {
      destroyAnonSources(sources);
      closeFiles(fileset);
    }
  }

  const failedPath = path.join(outRoot, FAILED_CSV);
  if (failed.length) writeFileAtomic(failedPath, toCsv([['original_path', 'error'], ...failed]));
  else fs.rmSync(failedPath, { force: true });

  say(`\nFinished in ${formatTime((Date.now() - started) / 1000)}: ${ok} slide(s) anonymized${failed.length ? `, ${failed.length} failed (listed in ${FAILED_CSV})` : ''}.`);
  say(`Output folder: ${outRoot}`);
  say('\nBefore you share or upload the output folder, REMOVE:');
  say(`  - ${MAPPING_CSV_NAME} (links the new names to the original ones)`);
  if (opts.keepLabels) say(`  - the ${LABELS_DIR}/ and ${MACROS_DIR}/ folders (original labels: patient information)`);
  if (failed.length) say(`  - ${FAILED_CSV}`);
  say('Keep them somewhere safe: they are your key back to the original slides.');
  await waitBeforeClosing();
  return failed.length ? 1 : 0;
}

main()
  .then((code) => {
    rl?.close();
    process.exit(code);
  })
  .catch(async (err) => {
    realError(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    await waitBeforeClosing();
    rl?.close();
    process.exit(2);
  });
