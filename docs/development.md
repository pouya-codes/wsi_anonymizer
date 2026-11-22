# Development notes

## How a slide is anonymized

The web app and the command-line program share the same code in `src/upload/`.

1. **Optional label and macro copy.** If the user asks for it, the label and macro images are read from
   the untouched original and saved as `labels/slide-NNNN_label.*` and `macros/slide-NNNN_macro.*`.
   These contain patient information.
2. **Scrub.** [EMPAIA WSI-anon](https://gitlab.com/empaia/integration/wsi-anon) 0.4.32, compiled to
   WebAssembly and included in `vendor/wsi-anon`, removes the label and macro images and its known
   identifying metadata. Changes are applied as overlays while the file is copied, so multi-GB slides
   are streamed rather than loaded into memory.
3. **Extra Aperio metadata scrub.** WSI-anon leaves some fields, notably `Title` (often the case
   barcode). For single-file Aperio SVS/TIFF, the description fields `Filename`, `Title`,
   `ScanScope ID`, `User`, `Barcode`, … become `X`, `Date`/`Time` become `01/01/00`/`00:00:00`, and the
   TIFF tags DocumentName / DateTime / Artist / HostComputer are blanked. All edits keep the same byte
   length, so no offsets move.
4. **Slides with no label and no macro** (common in public datasets such as TCGA): WSI-anon refuses
   these. For single-file Aperio SVS/TIFF the slide is then copied with only step 3 applied. The
   mapping row gets `label_status = none`.
5. **Rename** to `slide-NNNN` (optional; numbering continues after files already in the output folder
   and rows already in the mapping file).
6. **Mapping.** One row per slide in `anonymization-mapping.csv` at the root of the output folder.

Label and macro export supports SVS, NDPI, BIF, Philips TIFF, generic TIFF and iSyntax (not MRXS yet).

## Read labels (web app only)

The *Read labels* step opens an output folder, shows each saved label with a text box and stores the
text in `anonymization-mapping.csv` (`label_text`, `label_status` = ocr / edited / reviewed / none,
`label_ocr_confidence`, `label_rotation`). The CSV is the save file.

- OCR: [Tesseract.js](https://github.com/naptha/tesseract.js) 7 with the English `best_int` model. Each
  label is tried upright and turned 90° / 270° / 180°. Good on printed labels; handwriting usually has
  to be typed.
- The OCR files are copied from `node_modules` to `public/ocr/<version>/` by
  `scripts/copy-ocr-assets.mjs` (runs before `dev` and `build`) and served by the app itself, never
  from a CDN.
- Saves are read-merge-write on the CSV (keyed by `anonymized_path`), so extra columns added in Excel
  are kept.

## Code layout

```
src/                         Vue 3 + PrimeVue web app (Vite)
  components/AnonymizeView.vue   step 1: anonymize
  components/LabelsView.vue      step 2: read labels (OCR, save)
  components/GuideView.vue       in-app user guide
  components/UsageView.vue       admin usage report (hosted mode)
  stores/localAnon.ts            run state, naming, per-slide pipeline
  stores/labels.ts               label rows, OCR queue, CSV save / resume
  ocr/labelOcr.ts                Tesseract.js wrapper
  upload/wsiAnon.ts              WSI-anon WebAssembly wrapper
  upload/associatedImages.ts     label/macro reader (TIFF/BigTIFF/NDPI/Philips XML), metadata scrub
  upload/mappingCsv.ts           anonymization-mapping.csv read / append / merge
  upload/localSave.ts            File System Access writer + download fallback
  upload/anonymizeNames.ts       slide-NNNN renaming
cli/                         command-line program (reuses src/upload/*)
  anonymize-cli.ts               questions, folder scan, per-slide pipeline, resume, summary
  diskFile.ts                    file-backed Blob look-alike for multi-GB slides
  png.ts                         small PNG encoder (node:zlib) for labels without a canvas
  build.mjs                      esbuild bundle + `deno compile` for every platform
server/                      zero-dependency Node server: password gate + static files (optional)
deploy/                      example systemd unit and Apache virtual host
vendor/wsi-anon/             EMPAIA WSI-anon 0.4.32 (MIT)
.github/workflows/           builds the programs and publishes releases
```

## Build

```bash
npm install
npm run dev              # web app with hot reload, http://localhost:5173
npm run typecheck
npm run build            # web app -> dist/
npm run build:cli        # -> cli/dist/slide-anonymizer.mjs (run with: node cli/dist/slide-anonymizer.mjs)
npm run build:cli-exe    # -> cli/dist/slide-anonymizer-{windows.exe,mac-apple-silicon,mac-intel,linux}
```

`build:cli-exe` uses [Deno](https://deno.com) (`deno compile`), which cross-compiles every platform
from one machine and ad-hoc signs the macOS programs. Point `DENO=/path/to/deno` at it if it is not on
`PATH`. The build compiles from an empty temporary folder: next to `package.json` Deno would also pack
`node_modules` (about 250 MB per program instead of 65–100 MB).

## Releases

`.github/workflows/release.yml` builds and smoke-tests the programs on every push. To publish a
version:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow then creates a GitHub Release with `slide-anonymizer-windows.exe`, the two macOS `.zip`
files, the Linux `.tar.gz` and `SHA256SUMS.txt`. The macOS and Linux programs are archived because
browsers drop the executable permission on downloaded files. Also bump `VERSION` in
`cli/anonymize-cli.ts`.

The programs are not signed with a paid Apple / Microsoft certificate, so users see a one-time warning.
Signing (Apple Developer ID + notarization, Windows Authenticode) would remove it.

## Hosting the web app

The built app in `dist/` is static and works on any web server. Writing into a folder needs the File
System Access API (Chrome / Edge) and a secure context (HTTPS or `localhost`).

`server/` adds an optional password gate with per-password usage counts:

```bash
npm run build
ANON_ENV_FILE=./local.env npm run set-password      # writes ANON_PASSWORD_HASH + ANON_SESSION_SECRET
set -a; . ./local.env; set +a
ANON_INSECURE_COOKIE=1 PORT=8790 npm start          # http://127.0.0.1:8790 (drop ANON_INSECURE_COOKIE behind HTTPS)
```

- More passwords (one per site or group): `npm run accounts -- add <id> --name "…"`, stored in
  `~/.config/anonymizer/accounts.json` (or `ANON_ACCOUNTS_FILE`). Restart after changes.
- After each saved slide the app posts `{bytes, format, files}` to `/api/usage`; the server appends it
  with the time and account to `~/.local/share/anonymizer/usage.jsonl`. No names, paths or label text
  are sent. Admin accounts get a *Usage* tab.
- `deploy/` has an example systemd unit and Apache reverse-proxy configuration.

Security notes for the hosted mode:

- Passwords are checked server-side (scrypt); app files are only served with a valid signed, HttpOnly
  session cookie (12 h). Failed logins are rate-limited.
- Responses are `Cache-Control: private`, so a CDN never caches gated files.
- CSP `connect-src 'self'`: the page cannot send data to any other site, and the server has no endpoint
  that accepts files.
