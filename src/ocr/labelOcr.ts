/**
 * On-device OCR for slide label images (Tesseract.js, WebAssembly).
 *
 * Everything runs in a Web Worker in this browser. The worker, core and English
 * model are served by this site from /ocr/<version>/ (scripts/copy-ocr-assets.mjs);
 * nothing is fetched from a CDN and no image leaves the computer.
 *
 * Tesseract reads printed / typed labels well. Handwriting is usually read
 * poorly or not at all; the user corrects or types those in the review list.
 */
import type Tesseract from 'tesseract.js';

const BASE = `${location.origin}/ocr/${__OCR_ASSET_DIR__}`;

/** Labels are small; upscale so text is roughly 300-dpi sized for Tesseract. */
const TARGET_LONG_SIDE = 1400;
const MAX_SCALE = 4;
/** Lines below this confidence are usually barcode / logo noise. */
const MIN_LINE_CONFIDENCE = 35;
/** Good enough at the current orientation — skip trying the others. */
const ACCEPT_CONFIDENCE = 80;

export interface LabelOcrResult {
  text: string;
  /** Mean confidence (0-100) of the kept lines. */
  confidence: number;
  /** Clockwise degrees the image was turned to read it (0, 90, 180, 270). */
  rotation: number;
}

let workerPromise: Promise<Tesseract.Worker> | null = null;

function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: `${BASE}/core`,
        langPath: `${BASE}/lang`,
        workerBlobURL: false,
        gzip: true,
        // The browser HTTP cache keeps the versioned model; no IndexedDB copy.
        cacheMethod: 'none',
      });
      await worker.setParameters({
        user_defined_dpi: '300',
        preserve_interword_spaces: '1',
      });
      return worker;
    })();
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

/** Load the OCR engine ahead of the first label (downloads ~7 MB once). */
export async function warmUpOcr(): Promise<void> {
  await getWorker();
}

export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (p) await (await p).terminate().catch(() => undefined);
}

/** Grayscale, upscaled, rotated copy of the label as a PNG for Tesseract. */
async function prepare(bitmap: ImageBitmap, rotation: number): Promise<Blob> {
  const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_LONG_SIDE / Math.max(bitmap.width, bitmap.height)));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const sideways = rotation % 180 !== 0;
  const canvas = new OffscreenCanvas(sideways ? h : w, sideways ? w : h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.filter = 'grayscale(1) contrast(1.2)';
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  return canvas.convertToBlob({ type: 'image/png' });
}

function alnumCount(s: string): number {
  return (s.match(/[A-Za-z0-9]/g) ?? []).length;
}

/** Keep confident, text-like lines; score = length-weighted confidence. */
function summarize(page: Tesseract.Page): { text: string; confidence: number; score: number } {
  const lines: { text: string; confidence: number }[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const text = line.text.replace(/\s+/g, ' ').trim();
        const alnum = alnumCount(text);
        if (line.confidence < MIN_LINE_CONFIDENCE || alnum < 2) continue;
        if (alnum / text.replace(/\s/g, '').length < 0.5) continue;
        lines.push({ text, confidence: line.confidence });
      }
    }
  }
  const weight = lines.reduce((s, l) => s + alnumCount(l.text), 0);
  const confidence = weight
    ? lines.reduce((s, l) => s + l.confidence * alnumCount(l.text), 0) / weight
    : 0;
  return {
    text: lines.map((l) => l.text).join('\n'),
    confidence: Math.round(confidence),
    // Favour readings that found more text, with diminishing returns.
    score: confidence * Math.min(1, weight / 12),
  };
}

/**
 * Read one label image. Labels are often stored sideways, so the image is read
 * upright first and turned 90° / 270° / 180° when that reading is weak.
 */
export async function readLabel(image: Blob, signal?: AbortSignal): Promise<LabelOcrResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new Error('This image format cannot be read in the browser (e.g. TIFF)');
  }
  try {
    const worker = await getWorker();
    let best: LabelOcrResult & { score: number } = { text: '', confidence: 0, rotation: 0, score: -1 };
    for (const rotation of [0, 90, 270, 180]) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { data } = await worker.recognize(
        await prepare(bitmap, rotation),
        {},
        { text: true, blocks: true }
      );
      const r = summarize(data);
      if (r.score > best.score) best = { ...r, rotation };
      if (r.confidence >= ACCEPT_CONFIDENCE && alnumCount(r.text) >= 4) break;
    }
    const { score: _score, ...result } = best;
    return result;
  } finally {
    bitmap.close();
  }
}
