# Slide Anonymizer — command-line version

For anonymizing **whole folders of slides at once** (hundreds or thousands), without a browser.
It does the same anonymization as the web app:

- removes the **slide label** and **macro image** from each slide,
- removes **identifying metadata** (file name, title, barcode, scanner ID, user, date and time),
- renames the slides to `slide-0001`, `slide-0002`, … (optional),
- writes `anonymization-mapping.csv`, linking each new name to the original.

**Your original slides are never changed.** Anonymized copies go into a new folder.
Nothing is uploaded anywhere; everything happens on your computer.

Supported formats: Aperio SVS, Hamamatsu NDPI, 3DHISTECH MRXS, Ventana BIF, Philips TIFF / iSyntax, generic TIFF.

---

## For users

### 1. Get the program

Download the file for your computer (no installation needed):

| Computer | File |
|---|---|
| Windows 10 / 11 | [slide-anonymizer-windows.exe](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-windows.exe) |
| Mac with Apple chip (M1, M2, M3, M4) | [slide-anonymizer-mac-apple-silicon.zip](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-mac-apple-silicon.zip) |
| Mac with Intel chip | [slide-anonymizer-mac-intel.zip](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-mac-intel.zip) |
| Linux (x86-64) | [slide-anonymizer-linux.tar.gz](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-linux.tar.gz) |

(On a Mac: Apple menu → *About This Mac* → "Chip" says Apple M… or "Processor" says Intel.
Double-click the downloaded `.zip` to unpack the program.)

### 2. Start it

**Windows** — double-click `slide-anonymizer-windows.exe`.
The first time, Windows may say *"Windows protected your PC"*: click **More info → Run anyway**.

**Mac** — the first time only: **right-click** (or Control-click) the file → **Open** → **Open**.
A Terminal window opens with the program. Afterwards you can simply double-click it.
If macOS says the file "can't be opened", open *System Settings → Privacy & Security*, scroll down and click **Open Anyway**.

### 3. Answer the questions

A window opens and asks:

1. **"Drag the folder with your slides into this window, then press Enter"** — drag the folder from
   Explorer / Finder into the window and press **Enter**. All slides in that folder and its sub-folders are found.
2. **"Where should the anonymized copies go?"** — press **Enter** to use a new folder next to it,
   called `<your folder> (anonymized)`, or drag another (empty) folder in.
3. **"Also keep a copy of the original labels?"** — type `y` and Enter if you want the original label
   pictures saved (in `labels/` and `macros/`), otherwise just press Enter.
4. **"Start?"** — press **Enter**.

It then shows each slide as it goes, and how much time is left. A slide usually takes a few
seconds (the time is mostly copying the file). You can leave it running.

**Windows shortcut:** you can also drag the slide folder straight onto `slide-anonymizer-windows.exe`.

### 4. When it is finished

The output folder contains:

| What | Share / upload it? |
|---|---|
| `slide-0001.svs`, `slide-0002.svs`, … | **Yes** — these are the anonymized slides |
| `anonymization-mapping.csv` | **No** — it links new names to original names. Keep it safe. |
| `labels/`, `macros/` (only if you chose to keep labels) | **No** — original labels contain patient information |
| `anonymization-failed.csv` (only if some slides failed) | **No** — lists the slides that could not be anonymized and why |

Slides that have no label at all (common in some scanners and public datasets) are still processed:
they are renamed and their metadata is removed. They are marked `none` in the `label_status` column.

### Stopping and continuing

You can close the window at any time. Start the program again with the **same two folders** and it
continues where it stopped: slides already done are skipped, and numbering continues.

New slides added to the input folder later are picked up the same way.

### Reading the label text afterwards (optional)

If you kept the labels, you can type or OCR the label text into the mapping file using step 2
("Read labels") of the web app: open it, go to *Read labels* and choose the output folder. Nothing is
uploaded. See the [wiki](https://github.com/pouya-codes/wsi_anonymizer/wiki/Web-App).

---

## Advanced: options

The program can also be run from a terminal (PowerShell, Terminal) with options, e.g. for scripts:

```
slide-anonymizer <input folder> [output folder] [options]

  --keep-names     keep the original file names and folders (default: slide-0001, ...)
  --keep-labels    also save the original label and macro images to labels/ and macros/
  --start <N>      first slide number (default: continue after what is in the output folder)
  --yes, -y        do not ask any questions
  --help, -h       show help
```

Example (Windows PowerShell):

```
.\slide-anonymizer-windows.exe "D:\Tumor bank\batch 1" "E:\Upload\batch 1" --yes
```

Exit code: 0 = all done, 1 = some slides failed (see `anonymization-failed.csv`), 2 = could not start.

---

## For developers

The command-line tool reuses the web app's code (`src/upload/*`: WSI-anon wrapper, label extraction,
metadata scrub, renaming, mapping CSV). New files:

| File | Purpose |
|---|---|
| `cli/anonymize-cli.ts` | Program: questions, folder scan, per-slide pipeline, resume, summary |
| `cli/diskFile.ts` | File-backed `Blob` look-alike, so multi-GB slides are read in pieces |
| `cli/png.ts` | Tiny PNG encoder (node:zlib) — saves labels as PNG without a browser canvas |
| `cli/build.mjs` | Bundles everything (incl. the WSI-anon WebAssembly) into one file, optionally compiles programs |

Build:

```bash
npm run build:cli        # -> cli/dist/slide-anonymizer.mjs  (run with: node cli/dist/slide-anonymizer.mjs)
npm run build:cli-exe    # also -> cli/dist/slide-anonymizer-{windows.exe,mac-apple-silicon,mac-intel,linux}
```

`build:cli-exe` uses [Deno](https://deno.com) (`deno compile`, cross-compiles all targets from one
machine and ad-hoc signs the macOS binaries). Install Deno on the build machine only, or point
`DENO=/path/to/deno` at it. Users need nothing installed.
Last built with Deno 2.9.8: Windows 77 MB, Mac Apple silicon 65 MB, Mac Intel 77 MB, Linux 100 MB
(the JavaScript runtime is inside each program). The build compiles from an empty temp folder,
because next to `package.json` Deno would also pack `node_modules` (~250 MB per program).

The programs are not code-signed with a paid Apple / Microsoft certificate, hence the one-time
"Run anyway" / "Open Anyway" steps above. Signing would remove those prompts.
