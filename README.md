# WSI Anonymizer

De-identify **whole-slide images** before you share them. The tool removes the slide **label** and
**macro** image, clears **identifying metadata** (file name, title, barcode, scanner ID, user, date and
time) and renames the slides to `slide-0001`, `slide-0002`, … It also writes a mapping file that links
each new name to the original.

Everything runs **on your own computer**. Nothing is uploaded, and your original slides are never
changed. Anonymized copies go into a new folder.

Supported formats: Aperio SVS, Hamamatsu NDPI, 3DHISTECH MRXS, Ventana BIF, Philips TIFF / iSyntax,
generic TIFF.

It comes in two forms that do the same anonymization:

| | Best for |
|---|---|
| **Command-line program** (Windows, Mac, Linux) | Whole folders, hundreds or thousands of slides, no browser needed. Double-click, drag a folder in, done. |
| **Web app** (Chrome / Edge) | Point-and-click use, plus the *Read labels* step (OCR or type the label text into the mapping file). |

## Download the command-line program

No installation needed. Pick the file for your computer:

| Computer | Download |
|---|---|
| Windows 10 / 11 | [slide-anonymizer-windows.exe](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-windows.exe) |
| Mac with Apple chip (M1–M4) | [slide-anonymizer-mac-apple-silicon.zip](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-mac-apple-silicon.zip) |
| Mac with Intel chip | [slide-anonymizer-mac-intel.zip](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-mac-intel.zip) |
| Linux (x86-64) | [slide-anonymizer-linux.tar.gz](https://github.com/pouya-codes/wsi_anonymizer/releases/latest/download/slide-anonymizer-linux.tar.gz) |

All versions are on the [Releases](https://github.com/pouya-codes/wsi_anonymizer/releases) page.

**Quick start:** double-click the program, drag your slide folder into the window, press Enter three
times. The anonymized copies appear in `<your folder> (anonymized)`.

The first time you open it, Windows or macOS shows a warning because the program is not signed with a
paid certificate. The [wiki](https://github.com/pouya-codes/wsi_anonymizer/wiki/Command-Line-Tool)
shows how to get past it, and explains every step.

## Documentation

The **[wiki](https://github.com/pouya-codes/wsi_anonymizer/wiki)** has:

- [Command-line tool](https://github.com/pouya-codes/wsi_anonymizer/wiki/Command-Line-Tool): download, first start, the questions, options for scripts
- [Web app](https://github.com/pouya-codes/wsi_anonymizer/wiki/Web-App): anonymize and read labels in the browser, and how to run your own copy
- [Output folder and mapping file](https://github.com/pouya-codes/wsi_anonymizer/wiki/Output-Folder-and-Mapping-File): what you may share and what you must keep private
- [Troubleshooting and FAQ](https://github.com/pouya-codes/wsi_anonymizer/wiki/Troubleshooting-and-FAQ)
- [Building from source](https://github.com/pouya-codes/wsi_anonymizer/wiki/Building-from-Source)

## Before you share

Do **not** share these from the output folder. Keep them somewhere safe; they are your key back to the
original slides:

- `anonymization-mapping.csv` (links new names to original names)
- `labels/` and `macros/` (original label pictures, which contain patient information)
- `anonymization-failed.csv` (lists original file names)

Removing labels and metadata does not remove every possible way to re-identify a slide (for example
text written on the tissue area itself). Check your institution's data-sharing rules.

## For developers

```bash
npm install
npm run dev              # web app at http://localhost:5173
npm run build            # web app -> dist/
npm run build:cli        # command-line bundle -> cli/dist/slide-anonymizer.mjs (runs with Node 20+)
npm run build:cli-exe    # stand-alone programs for all platforms (needs Deno)
```

Pushing a tag such as `v1.0.1` makes GitHub Actions build all programs and publish them as a release
(`.github/workflows/release.yml`). See [docs/development.md](docs/development.md) for the code layout
and how to host the web app.

## Credits

Slide scrubbing uses [EMPAIA WSI-anon](https://gitlab.com/empaia/integration/wsi-anon) (MIT licence),
included as WebAssembly in `vendor/wsi-anon`. Label OCR in the web app uses
[Tesseract.js](https://github.com/naptha/tesseract.js). Developed at the AIM Lab for
[cPathPortal](https://cpathportal.com).
