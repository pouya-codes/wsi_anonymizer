/**
 * Read the ORIGINAL label and macro images out of a slide, in the browser.
 *
 * WSI-anon removes these images but cannot hand them back, so before a slide
 * is scrubbed we pull them from the untouched source file and let the caller
 * archive them (the local Anonymize view saves them under labels/ and macros/).
 *
 * Supported layouts (mirroring tifffile / OpenSlide conventions):
 *  - Aperio SVS: IFD description line 2 `label …` / `macro …`, or (GT450 and
 *    others) a non-tiled IFD with NewSubfileType 1 (label) / 9 (macro).
 *  - Hamamatsu NDPI: macro IFD has tag 65421 (source lens) == -1. NDPI is a
 *    classic TIFF with 64-bit IFD offsets and high offset bits after each IFD.
 *  - Ventana BIF, Philips TIFF, generic TIFF: IFD description starting with
 *    `Label` / `Label_Image` / `Macro`.
 *  - Philips TIFF (older) and iSyntax: base64 JPEGs inside the XML header
 *    (`PIM_DP_IMAGE_TYPE` LABELIMAGE / MACROIMAGE).
 *  - MRXS: not supported yet (images live in the Data*.dat index structure).
 *
 * Output is a viewable image when the browser can decode the data: JPEG data
 * is passed through untouched as .jpg, uncompressed / LZW / Deflate / PackBits
 * 8-bit data is decoded and saved losslessly as .png. Anything else (e.g.
 * JPEG 2000) is copied verbatim into a standalone single-image .tif.
 */
import type { LocalFileset } from '@/types';
import { extensionOf } from './filesets';
import type { ByteEdit } from './wsiAnon';

export type AssociatedKind = 'label' | 'macro';

export interface AssociatedImage {
  kind: AssociatedKind;
  blob: Blob;
  ext: 'jpg' | 'png' | 'tif';
  /** Where it came from inside the slide, for notes / debugging. */
  source: string;
}

export interface AssociatedResult {
  images: AssociatedImage[];
  /** Human-readable reasons when nothing (or not everything) could be read. */
  notes: string[];
  /** True when the whole slide structure was read, so "no label" is certain. */
  complete: boolean;
}

const TIFF_FORMATS = new Set(['.svs', '.tif', '.tiff', '.ndpi', '.bif']);
const MAX_IFDS = 1024;
const MAX_DESCRIPTION = 64 * 1024 * 1024;
const MAX_IMAGE_SIDE = 16384;

export function supportsAssociatedExtraction(path: string): boolean {
  const ext = extensionOf(path);
  return TIFF_FORMATS.has(ext) || ext === '.isyntax';
}

/* ------------------------------------------------------------------------ */
/* TIFF structure                                                            */
/* ------------------------------------------------------------------------ */

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
  16: 8, 17: 8, 18: 8,
};

interface TiffFormat {
  le: boolean;
  big: boolean;
  ndpi: boolean;
}

interface TagEntry {
  type: number;
  count: number;
  /** Absolute file offset of the value bytes (inline values point into the IFD). */
  valueOffset: number;
  /** NDPI only: full 64-bit inline value for count-1 integer tags. */
  ndpiInline?: number;
}

interface Ifd {
  index: number;
  tags: Map<number, TagEntry>;
}

class FileReader64 {
  constructor(
    private readonly file: File,
    readonly fmt: TiffFormat
  ) {}

  get size(): number {
    return this.file.size;
  }

  async view(offset: number, length: number): Promise<DataView> {
    if (offset < 0 || length < 0 || offset + length > this.file.size) {
      throw new Error(`Read outside file (${offset}+${length})`);
    }
    const buf = await this.file.slice(offset, offset + length).arrayBuffer();
    return new DataView(buf);
  }

  async bytes(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array((await this.view(offset, length)).buffer);
  }

  u16(v: DataView, at: number): number {
    return v.getUint16(at, this.fmt.le);
  }

  u32(v: DataView, at: number): number {
    return v.getUint32(at, this.fmt.le);
  }

  u64(v: DataView, at: number): number {
    const a = v.getUint32(at, this.fmt.le);
    const b = v.getUint32(at + 4, this.fmt.le);
    return this.fmt.le ? a + b * 2 ** 32 : b + a * 2 ** 32;
  }
}

async function openTiff(file: File, isNdpi: boolean): Promise<{ r: FileReader64; first: number }> {
  const head = new DataView(await file.slice(0, 16).arrayBuffer());
  const order = head.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Not a TIFF file');
  const le = order === 0x4949;
  const version = head.getUint16(2, le);
  if (version === 43) {
    const r = new FileReader64(file, { le, big: true, ndpi: false });
    return { r, first: r.u64(head, 8) };
  }
  if (version !== 42) throw new Error(`Unsupported TIFF version ${version}`);
  const ndpi = isNdpi && le;
  const r = new FileReader64(file, { le, big: false, ndpi });
  return { r, first: ndpi ? r.u64(head, 4) : r.u32(head, 4) };
}

async function readIfd(r: FileReader64, offset: number, index: number): Promise<{ ifd: Ifd; next: number }> {
  const { big, ndpi } = r.fmt;
  const countSize = big ? 8 : 2;
  const entrySize = big ? 20 : 12;
  const nextSize = big || ndpi ? 8 : 4;
  const countView = await r.view(offset, countSize);
  const count = big ? r.u64(countView, 0) : r.u16(countView, 0);
  if (count > 4096) throw new Error(`Suspicious IFD with ${count} tags`);

  const blockLen = countSize + count * entrySize + nextSize + (ndpi ? 4 * count : 0);
  const v = await r.view(offset, Math.min(blockLen, r.size - offset));
  const tags = new Map<number, TagEntry>();
  const highBase = countSize + count * entrySize + nextSize;

  for (let i = 0; i < count; i++) {
    const e = countSize + i * entrySize;
    const tag = r.u16(v, e);
    const type = r.u16(v, e + 2);
    const n = big ? r.u64(v, e + 4) : r.u32(v, e + 4);
    const valueField = e + (big ? 12 : 8);
    const typeSize = TYPE_SIZE[type];
    if (!typeSize) continue;
    const inlineCap = big ? 8 : 4;
    const size = typeSize * n;
    const high = ndpi ? r.u32(v, highBase + 4 * i) : 0;
    let valueOffset: number;
    if (size <= inlineCap) {
      valueOffset = offset + valueField;
    } else if (big) {
      valueOffset = r.u64(v, valueField);
    } else {
      valueOffset = r.u32(v, valueField) + high * 2 ** 32;
    }
    const entry: TagEntry = { type, count: n, valueOffset };
    if (ndpi && size <= 4 && n === 1 && (type === 4 || type === 13)) {
      entry.ndpiInline = r.u32(v, valueField) + high * 2 ** 32;
    }
    // Duplicate tags: keep the first, as libtiff (and so OpenSlide) does.
    if (!tags.has(tag)) tags.set(tag, entry);
  }
  const nextAt = countSize + count * entrySize;
  const next = big || ndpi ? r.u64(v, nextAt) : r.u32(v, nextAt);
  return { ifd: { index, tags }, next };
}

async function readIfds(r: FileReader64, first: number): Promise<Ifd[]> {
  const out: Ifd[] = [];
  const seen = new Set<number>();
  let offset = first;
  while (offset && !seen.has(offset) && out.length < MAX_IFDS && offset < r.size) {
    seen.add(offset);
    const { ifd, next } = await readIfd(r, offset, out.length);
    out.push(ifd);
    offset = next;
  }
  return out;
}

async function tagNumbers(r: FileReader64, ifd: Ifd, tag: number): Promise<number[] | null> {
  const e = ifd.tags.get(tag);
  if (!e) return null;
  if (e.ndpiInline != null) return [e.ndpiInline];
  const size = TYPE_SIZE[e.type];
  const v = await r.view(e.valueOffset, size * e.count);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const at = i * size;
    switch (e.type) {
      case 1: case 7: out.push(v.getUint8(at)); break;
      case 6: out.push(v.getInt8(at)); break;
      case 3: out.push(r.u16(v, at)); break;
      case 8: out.push(v.getInt16(at, r.fmt.le)); break;
      case 4: case 13: out.push(r.u32(v, at)); break;
      case 9: out.push(v.getInt32(at, r.fmt.le)); break;
      case 11: out.push(v.getFloat32(at, r.fmt.le)); break;
      case 12: out.push(v.getFloat64(at, r.fmt.le)); break;
      case 16: case 18: out.push(r.u64(v, at)); break;
      default: return null;
    }
  }
  return out;
}

async function tagNumber(r: FileReader64, ifd: Ifd, tag: number): Promise<number | null> {
  return (await tagNumbers(r, ifd, tag))?.[0] ?? null;
}

async function tagBytes(r: FileReader64, ifd: Ifd, tag: number, max = Infinity): Promise<Uint8Array | null> {
  const e = ifd.tags.get(tag);
  if (!e) return null;
  const len = Math.min(TYPE_SIZE[e.type] * e.count, max);
  return r.bytes(e.valueOffset, len);
}

async function tagString(r: FileReader64, ifd: Ifd, tag: number, max = MAX_DESCRIPTION): Promise<string> {
  const b = await tagBytes(r, ifd, tag, max);
  if (!b) return '';
  const end = b.indexOf(0);
  return new TextDecoder('latin1').decode(end >= 0 ? b.subarray(0, end) : b);
}

/* ------------------------------------------------------------------------ */
/* Which IFD is a label / macro                                              */
/* ------------------------------------------------------------------------ */

async function classify(r: FileReader64, ifd: Ifd, description: string): Promise<AssociatedKind | null> {
  const tiled = ifd.tags.has(322);
  const subfile = (await tagNumber(r, ifd, 254)) ?? 0;

  if (description.startsWith('Aperio')) {
    const line2 = (description.split(/\r?\n/)[1] ?? '').trim().toLowerCase();
    if (line2.startsWith('label')) return 'label';
    if (line2.startsWith('macro')) return 'macro';
    // GT450 and some converters omit the keyword; fall back on subfile type.
    if (!tiled && ifd.index > 0 && subfile === 9) return 'macro';
    if (!tiled && ifd.index > 1 && subfile === 1) return 'label';
    return null;
  }

  if (r.fmt.ndpi || ifd.tags.has(65421)) {
    const lens = await tagNumber(r, ifd, 65421);
    if (lens === -1) return 'macro';
  }

  const d = description.trim().toLowerCase();
  if (/^label(?:[ _]image)?\b/.test(d)) return 'label';
  if (/^macro\b/.test(d)) return 'macro';
  return null;
}

/* ------------------------------------------------------------------------ */
/* Decoding                                                                  */
/* ------------------------------------------------------------------------ */

interface ImageLayout {
  width: number;
  height: number;
  compression: number;
  photometric: number;
  spp: number;
  bps: number[];
  planar: number;
  predictor: number;
  tiled: boolean;
  tileW: number;
  tileH: number;
  rowsPerStrip: number;
  offsets: number[];
  counts: number[];
  jpegTables: Uint8Array | null;
}

async function layoutOf(r: FileReader64, ifd: Ifd): Promise<ImageLayout> {
  const width = (await tagNumber(r, ifd, 256)) ?? 0;
  const height = (await tagNumber(r, ifd, 257)) ?? 0;
  const tiled = ifd.tags.has(322) && ifd.tags.has(324);
  const offsets = (await tagNumbers(r, ifd, tiled ? 324 : 273)) ?? [];
  const counts = (await tagNumbers(r, ifd, tiled ? 325 : 279)) ?? [];
  return {
    width,
    height,
    compression: (await tagNumber(r, ifd, 259)) ?? 1,
    photometric: (await tagNumber(r, ifd, 262)) ?? 2,
    spp: (await tagNumber(r, ifd, 277)) ?? 1,
    bps: (await tagNumbers(r, ifd, 258)) ?? [1],
    planar: (await tagNumber(r, ifd, 284)) ?? 1,
    predictor: (await tagNumber(r, ifd, 317)) ?? 1,
    tiled,
    tileW: (await tagNumber(r, ifd, 322)) ?? width,
    tileH: (await tagNumber(r, ifd, 323)) ?? height,
    rowsPerStrip: Math.min((await tagNumber(r, ifd, 278)) ?? height, height),
    offsets,
    counts,
    jpegTables: await tagBytes(r, ifd, 347),
  };
}

const SOI = [0xff, 0xd8];
/** APP14 "Adobe" marker with transform=0: tells decoders the JPEG is RGB, not YCbCr. */
const ADOBE_RGB = [
  0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00,
];

function hasAdobeMarker(b: Uint8Array): boolean {
  for (let i = 0; i + 6 < Math.min(b.length, 4096); i++) {
    if (b[i] === 0xff && b[i + 1] === 0xee && b[i + 4] === 0x41 && b[i + 5] === 0x64) return true;
  }
  return false;
}

/** Turn one TIFF JPEG strip / tile into a standalone JPEG file. */
function standaloneJpeg(piece: Uint8Array, tables: Uint8Array | null, rgb: boolean): Uint8Array {
  let body = piece;
  if (tables && tables.length > 4) {
    // tables = SOI … EOI, piece = SOI … EOI  →  SOI tables… piece-body… EOI
    const merged = new Uint8Array(tables.length - 2 + piece.length - 2);
    merged.set(tables.subarray(0, tables.length - 2), 0);
    merged.set(piece.subarray(2), tables.length - 2);
    body = merged;
  }
  if (!rgb || hasAdobeMarker(body)) return body;
  const out = new Uint8Array(body.length + ADOBE_RGB.length);
  out.set(SOI, 0);
  out.set(ADOBE_RGB, 2);
  out.set(body.subarray(2), 2 + ADOBE_RGB.length);
  return out;
}

/** TIFF LZW (MSB-first, 9–12 bit codes, early change). */
export function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
  }
  let next = 258;
  let codeLen = 9;
  let bitPos = 0;
  let op = 0;
  let old = -1;
  const totalBits = input.length * 8;

  const readCode = (): number => {
    if (bitPos + codeLen > totalBits) return 257;
    const byte = bitPos >> 3;
    const window =
      (input[byte] << 16) | ((input[byte + 1] ?? 0) << 8) | (input[byte + 2] ?? 0);
    const code = (window >> (24 - (bitPos & 7) - codeLen)) & ((1 << codeLen) - 1);
    bitPos += codeLen;
    return code;
  };
  const firstByte = (code: number): number => {
    while (prefix[code] >= 0) code = prefix[code];
    return suffix[code];
  };
  const emit = (code: number): void => {
    const len = length[code];
    let at = op + len - 1;
    for (let c = code; c >= 0 && at >= op; c = prefix[c]) {
      if (at < expected) out[at] = suffix[c];
      at--;
    }
    op += len;
  };
  const add = (pre: number, byte: number): void => {
    if (next >= 4096) return;
    prefix[next] = pre;
    suffix[next] = byte;
    length[next] = length[pre] + 1;
    next++;
    if (next + 1 >= 1 << codeLen && codeLen < 12) codeLen++;
  };

  while (op < expected) {
    let code = readCode();
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      codeLen = 9;
      code = readCode();
      if (code === 257) break;
      emit(code);
      old = code;
      continue;
    }
    if (old < 0) {
      emit(code);
    } else if (code < next) {
      emit(code);
      add(old, firstByte(code));
    } else {
      add(old, firstByte(old));
      emit(code);
    }
    old = code;
  }
  return out;
}

function packbitsDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let ip = 0;
  let op = 0;
  while (ip < input.length && op < expected) {
    const n = (input[ip++] << 24) >> 24;
    if (n >= 0) {
      for (let i = 0; i <= n && op < expected; i++) out[op++] = input[ip++];
    } else if (n !== -128) {
      const b = input[ip++];
      for (let i = 0; i < 1 - n && op < expected; i++) out[op++] = b;
    }
  }
  return out;
}

async function inflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeRaw(piece: Uint8Array, L: ImageLayout, expected: number): Promise<Uint8Array> {
  switch (L.compression) {
    case 1:
      return piece;
    case 5:
      return lzwDecode(piece, expected);
    case 8:
    case 32946:
      return inflate(piece);
    case 32773:
      return packbitsDecode(piece, expected);
    default:
      throw new Error(`compression ${L.compression}`);
  }
}

/** Raw 8-bit RGB(A) / gray pixels → RGBA bytes. */
function toRgba(px: Uint8Array, w: number, h: number, L: ImageLayout): Uint8ClampedArray {
  const spp = L.spp;
  if (L.predictor === 2) {
    const row = w * spp;
    for (let y = 0; y < h; y++) {
      const base = y * row;
      for (let i = spp; i < row; i++) px[base + i] = (px[base + i] + px[base + i - spp]) & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += spp) {
    const o = i * 4;
    if (spp >= 3) {
      rgba[o] = px[p];
      rgba[o + 1] = px[p + 1];
      rgba[o + 2] = px[p + 2];
      rgba[o + 3] = spp >= 4 ? px[p + 3] : 255;
    } else {
      const g = L.photometric === 0 ? 255 - px[p] : px[p];
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
      rgba[o + 3] = spp === 2 ? px[p + 1] : 255;
    }
  }
  return rgba;
}

function toImageData(px: Uint8Array, w: number, h: number, L: ImageLayout): ImageData {
  return new ImageData(toRgba(px, w, h, L), w, h);
}

/** RGBA → PNG for environments without a canvas (the command-line tool sets this). */
export type RawPngEncoder = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>;
let rawPngEncoder: RawPngEncoder | null = null;
export function setRawPngEncoder(encoder: RawPngEncoder | null): void {
  rawPngEncoder = encoder;
}

let canvasUsable: boolean | null = null;
/** True when a 2D canvas really works (Deno has OffscreenCanvas but no 2D context). */
function hasCanvas(): boolean {
  if (canvasUsable === null) {
    try {
      canvasUsable = !!makeCanvas(1, 1).ctx;
    } catch {
      canvasUsable = false;
    }
  }
  return canvasUsable;
}

/** Decode uncompressed / LZW / Deflate / PackBits strips or tiles without a canvas. */
async function renderPngWithoutCanvas(L: ImageLayout, pieces: Uint8Array[], encode: RawPngEncoder): Promise<Blob> {
  const out = new Uint8Array(L.width * L.height * 4);
  const across = L.tiled ? Math.ceil(L.width / L.tileW) : 1;
  for (let i = 0; i < pieces.length; i++) {
    const x = L.tiled ? (i % across) * L.tileW : 0;
    const y = L.tiled ? Math.floor(i / across) * L.tileH : i * L.rowsPerStrip;
    if (y >= L.height) break;
    const pw = L.tiled ? L.tileW : L.width;
    const ph = L.tiled ? L.tileH : Math.min(L.rowsPerStrip, L.height - y);
    const expected = pw * ph * L.spp;
    const px = await decodeRaw(pieces[i], L, expected);
    if (px.length < expected) throw new Error('short strip');
    const rgba = toRgba(px.slice(0, expected), pw, ph, L);
    for (let row = 0; row < ph && y + row < L.height; row++) {
      const w = Math.min(pw, L.width - x);
      out.set(rgba.subarray(row * pw * 4, row * pw * 4 + w * 4), ((y + row) * L.width + x) * 4);
    }
  }
  const png = await encode(out, L.width, L.height);
  return new Blob([png], { type: 'image/png' });
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } {
  let canvas: AnyCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D unavailable');
  return { canvas, ctx };
}

async function canvasToPng(canvas: AnyCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
      'image/png'
    )
  );
}

function canDecodeToPng(L: ImageLayout): boolean {
  if (!L.width || !L.height || L.width > MAX_IMAGE_SIDE || L.height > MAX_IMAGE_SIDE) return false;
  if (L.planar !== 1) return false;
  if (L.compression === 7) return true;
  if (![1, 5, 8, 32946, 32773].includes(L.compression)) return false;
  if (!L.bps.every((b) => b === 8)) return false;
  if (L.photometric === 2) return L.spp === 3 || L.spp === 4;
  if (L.photometric === 0 || L.photometric === 1) return L.spp === 1 || L.spp === 2;
  return false;
}

async function piecesOf(r: FileReader64, L: ImageLayout): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let i = 0; i < L.offsets.length; i++) out.push(await r.bytes(L.offsets[i], L.counts[i] ?? 0));
  return out;
}

async function renderPng(L: ImageLayout, pieces: Uint8Array[]): Promise<Blob> {
  if (!hasCanvas()) {
    if (!rawPngEncoder || L.compression === 7) throw new Error('No canvas to decode this image');
    return renderPngWithoutCanvas(L, pieces, rawPngEncoder);
  }
  const { canvas, ctx } = makeCanvas(L.width, L.height);
  const across = L.tiled ? Math.ceil(L.width / L.tileW) : 1;
  for (let i = 0; i < pieces.length; i++) {
    const x = L.tiled ? (i % across) * L.tileW : 0;
    const y = L.tiled ? Math.floor(i / across) * L.tileH : i * L.rowsPerStrip;
    if (y >= L.height) break;
    const pw = L.tiled ? L.tileW : L.width;
    const ph = L.tiled ? L.tileH : Math.min(L.rowsPerStrip, L.height - y);
    if (L.compression === 7) {
      const jpg = standaloneJpeg(pieces[i], L.jpegTables, L.photometric === 2);
      const bitmap = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
      ctx.drawImage(bitmap, x, y);
      bitmap.close();
    } else {
      const expected = pw * ph * L.spp;
      const px = await decodeRaw(pieces[i], L, expected);
      if (px.length < expected) throw new Error('short strip');
      ctx.putImageData(toImageData(px.slice(0, expected), pw, ph, L), x, y);
    }
  }
  return canvasToPng(canvas);
}

/* ---- Verbatim single-image TIFF (fallback for data browsers can't decode) */

async function verbatimTiff(r: FileReader64, ifd: Ifd, L: ImageLayout, pieces: Uint8Array[]): Promise<Blob> {
  const copy = [256, 257, 258, 259, 262, 277, 278, 284, 317, 322, 323, 338, 339, 347, 529, 530, 531, 532];
  type Out = { tag: number; type: number; data: Uint8Array; count: number };
  const tags: Out[] = [];
  for (const tag of copy) {
    if (L.tiled && tag === 278) continue;
    if (!L.tiled && (tag === 322 || tag === 323)) continue;
    const e = ifd.tags.get(tag);
    if (!e) continue;
    const typeSize = TYPE_SIZE[e.type];
    const src = await r.bytes(e.valueOffset, typeSize * e.count);
    // Re-encode multi-byte values little-endian.
    const data = new Uint8Array(src.length);
    for (let i = 0; i < e.count; i++) {
      for (let b = 0; b < typeSize; b++) {
        data[i * typeSize + b] = r.fmt.le ? src[i * typeSize + b] : src[i * typeSize + (typeSize - 1 - b)];
      }
    }
    if ((e.type === 16 || e.type === 18) && tag !== 347) continue; // no 64-bit types in classic TIFF
    tags.push({ tag, type: e.type, data, count: e.count });
  }

  const dataLen = pieces.reduce((s, p) => s + p.length, 0);
  const n = pieces.length;
  const offTag = L.tiled ? 324 : 273;
  const cntTag = L.tiled ? 325 : 279;
  tags.push({ tag: offTag, type: 4, data: new Uint8Array(4 * n), count: n });
  tags.push({ tag: cntTag, type: 4, data: new Uint8Array(4 * n), count: n });
  tags.sort((a, b) => a.tag - b.tag);

  const extLen = tags.reduce((s, t) => s + (t.data.length > 4 ? t.data.length + (t.data.length & 1) : 0), 0);
  const ifdOffset = 8 + dataLen + extLen;
  const total = ifdOffset + 2 + tags.length * 12 + 4;
  const buf = new Uint8Array(total);
  const v = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0], 0);
  v.setUint32(4, ifdOffset, true);

  let at = 8;
  const pieceOffsets: number[] = [];
  for (const p of pieces) {
    pieceOffsets.push(at);
    buf.set(p, at);
    at += p.length;
  }
  const offs = tags.find((t) => t.tag === offTag) as Out;
  const cnts = tags.find((t) => t.tag === cntTag) as Out;
  const offView = new DataView(offs.data.buffer);
  const cntView = new DataView(cnts.data.buffer);
  pieces.forEach((p, i) => {
    offView.setUint32(4 * i, pieceOffsets[i], true);
    cntView.setUint32(4 * i, p.length, true);
  });

  v.setUint16(ifdOffset, tags.length, true);
  tags.forEach((t, i) => {
    const e = ifdOffset + 2 + i * 12;
    v.setUint16(e, t.tag, true);
    v.setUint16(e + 2, t.type, true);
    v.setUint32(e + 4, t.count, true);
    if (t.data.length <= 4) {
      buf.set(t.data, e + 8);
    } else {
      v.setUint32(e + 8, at, true);
      buf.set(t.data, at);
      at += t.data.length + (t.data.length & 1);
    }
  });
  v.setUint32(ifdOffset + 2 + tags.length * 12, 0, true);
  return new Blob([buf], { type: 'image/tiff' });
}

async function extractIfdImage(r: FileReader64, ifd: Ifd, kind: AssociatedKind): Promise<AssociatedImage> {
  const L = await layoutOf(r, ifd);
  if (!L.offsets.length) throw new Error('image has no data');
  const pieces = await piecesOf(r, L);
  const source = `IFD ${ifd.index}`;

  // Single JPEG strip: pass the original bytes through as a .jpg.
  if (L.compression === 7 && pieces.length === 1 && !L.tiled) {
    const jpg = standaloneJpeg(pieces[0], L.jpegTables, L.photometric === 2);
    return { kind, blob: new Blob([jpg], { type: 'image/jpeg' }), ext: 'jpg', source };
  }
  if (canDecodeToPng(L)) {
    try {
      return { kind, blob: await renderPng(L, pieces), ext: 'png', source };
    } catch {
      /* fall through to a verbatim copy */
    }
  }
  return { kind, blob: await verbatimTiff(r, ifd, L, pieces), ext: 'tif', source };
}

/* ------------------------------------------------------------------------ */
/* Philips XML (old Philips TIFF, iSyntax)                                   */
/* ------------------------------------------------------------------------ */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function philipsImagesFromXml(xml: string): AssociatedImage[] {
  if (!xml.includes('PIM_DP_IMAGE_TYPE')) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: AssociatedImage[] = [];
  for (const obj of Array.from(doc.querySelectorAll('DataObject[ObjectType="DPScannedImage"]'))) {
    const attr = (name: string) =>
      Array.from(obj.children).find(
        (c) => c.tagName === 'Attribute' && c.getAttribute('Name') === name
      )?.textContent ?? '';
    const type = attr('PIM_DP_IMAGE_TYPE').trim().toUpperCase();
    const kind: AssociatedKind | null =
      type === 'LABELIMAGE' ? 'label' : type === 'MACROIMAGE' ? 'macro' : null;
    const data = attr('PIM_DP_IMAGE_DATA').trim();
    if (!kind || !data) continue;
    out.push({
      kind,
      blob: new Blob([base64ToBytes(data)], { type: 'image/jpeg' }),
      ext: 'jpg',
      source: 'Philips XML',
    });
  }
  return out;
}

/** iSyntax: the XML header runs until the first 0x04 (EOT) byte. */
async function isyntaxHeader(file: File): Promise<string> {
  const step = 4 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < Math.min(file.size, MAX_DESCRIPTION); offset += step) {
    const chunk = new Uint8Array(await file.slice(offset, offset + step).arrayBuffer());
    const eot = chunk.indexOf(0x04);
    parts.push(eot >= 0 ? chunk.subarray(0, eot) : chunk);
    if (eot >= 0) break;
  }
  return new TextDecoder('utf-8').decode(await new Blob(parts).arrayBuffer());
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Extract label / macro images from the main file of a fileset. Never throws
 * for format problems — they are reported in `notes` so anonymization can go on.
 */
export async function extractAssociatedImages(fs: LocalFileset): Promise<AssociatedResult> {
  const ext = extensionOf(fs.main);
  const main = fs.files.find((f) => f.path === fs.main);
  if (!main) return { images: [], notes: ['Main slide file is missing'], complete: false };
  const notes: string[] = [];

  if (ext === '.isyntax') {
    try {
      const images = philipsImagesFromXml(await isyntaxHeader(main.file));
      if (!images.length) notes.push(NO_ASSOCIATED_NOTE);
      return { images, notes, complete: true };
    } catch (err) {
      return {
        images: [],
        notes: [`Could not read iSyntax header: ${(err as Error).message}`],
        complete: false,
      };
    }
  }

  if (!TIFF_FORMATS.has(ext)) {
    return {
      images: [],
      notes: [`Saving labels / macros is not supported for ${ext || 'this format'} yet`],
      complete: false,
    };
  }

  const images: AssociatedImage[] = [];
  try {
    const { r, first } = await openTiff(main.file, ext === '.ndpi');
    const ifds = await readIfds(r, first);
    for (const ifd of ifds) {
      const desc = await tagString(r, ifd, 270);
      if (ifd.index === 0 && desc.includes('PIM_DP_IMAGE_TYPE')) {
        images.push(...philipsImagesFromXml(desc));
      }
      let kind: AssociatedKind | null = null;
      try {
        kind = await classify(r, ifd, desc);
        if (kind) images.push(await extractIfdImage(r, ifd, kind));
      } catch (err) {
        notes.push(`Could not read ${kind ?? 'image'} at IFD ${ifd.index}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    notes.push(`Could not read slide structure: ${(err as Error).message}`);
  }
  const complete = !notes.length;
  if (!images.length && complete) notes.push(NO_ASSOCIATED_NOTE);
  return { images, notes, complete };
}

export const NO_ASSOCIATED_NOTE = 'This slide has no label or macro image';

/* ------------------------------------------------------------------------ */
/* Metadata scrub for Aperio TIFF (our own, alongside / instead of WSI-anon) */
/* ------------------------------------------------------------------------ */

/** Aperio description fields that identify the patient, case, scanner or operator. */
const APERIO_REDACT = new Set([
  'scanscope id', 'filename', 'title', 'user', 'barcode', 'rack', 'slide', 'slide id',
  'patient', 'patient id', 'case', 'case id', 'specimen', 'accession', 'operator',
]);
/** Same replacements WSI-anon uses, so both paths give the same output. */
const APERIO_FIXED: Record<string, string> = { date: '01/01/00', time: '00:00:00' };
/** Free-text TIFF tags that can carry names, paths or dates. */
const TEXT_TAGS: Record<number, string | null> = {
  269: null, // DocumentName
  306: '1900:01:01 00:00:00', // DateTime
  315: null, // Artist
  316: null, // HostComputer
};

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

function sameLength(fixed: string | null | undefined, n: number): string {
  return fixed && fixed.length === n ? fixed : 'X'.repeat(n);
}

/** In-place edits that blank identifying `|Key = value` fields of one description. */
function aperioDescriptionEdits(desc: string, base: number): ByteEdit[] {
  const edits: ByteEdit[] = [];
  for (const m of desc.matchAll(/\|([^=|\r\n]+)=([^|]*)/g)) {
    const key = m[1].trim().toLowerCase();
    const value = m[2];
    const lead = value.length - value.trimStart().length;
    const core = value.trim();
    if (!core.length) continue;
    let repl: string;
    if (APERIO_REDACT.has(key)) repl = 'X'.repeat(core.length);
    else if (key in APERIO_FIXED) repl = sameLength(APERIO_FIXED[key], core.length);
    else continue;
    const at = (m.index ?? 0) + 1 + m[1].length + 1 + lead;
    edits.push({ offset: base + at, bytes: ascii(repl) });
  }
  return edits;
}

export interface MetadataScrubPlan {
  edits: ByteEdit[];
  hasLabel: boolean;
  hasMacro: boolean;
}

/**
 * For single-file Aperio TIFF (SVS) slides: the in-place edits that remove
 * identifying metadata (description fields and free-text TIFF tags), and
 * whether the slide has a label / macro image. Returns null for other formats.
 *
 * Used on top of WSI-anon (which keeps `Title`, often the case barcode), and
 * instead of it for slides without a label or macro, which WSI-anon refuses.
 */
export async function planMetadataScrub(fs: LocalFileset): Promise<MetadataScrubPlan | null> {
  const ext = extensionOf(fs.main);
  if (!['.svs', '.tif', '.tiff'].includes(ext) || fs.files.length !== 1) return null;
  const main = fs.files.find((f) => f.path === fs.main);
  if (!main) return null;
  const { r, first } = await openTiff(main.file, false);
  const ifds = await readIfds(r, first);
  let aperio = false;
  let hasLabel = false;
  let hasMacro = false;
  const edits: ByteEdit[] = [];
  for (const ifd of ifds) {
    const desc = await tagString(r, ifd, 270);
    if (desc.startsWith('Aperio')) {
      aperio = true;
      edits.push(...aperioDescriptionEdits(desc, ifd.tags.get(270)!.valueOffset));
    }
    const kind = await classify(r, ifd, desc);
    if (kind === 'label') hasLabel = true;
    if (kind === 'macro') hasMacro = true;
    for (const [tag, fixed] of Object.entries(TEXT_TAGS)) {
      const e = ifd.tags.get(Number(tag));
      if (!e || e.type !== 2) continue;
      const b = await tagBytes(r, ifd, Number(tag), 4096);
      if (!b) continue;
      const nul = b.indexOf(0);
      const n = nul >= 0 ? nul : b.length;
      if (n) edits.push({ offset: e.valueOffset, bytes: ascii(sameLength(fixed, n)) });
    }
  }
  return aperio ? { edits, hasLabel, hasMacro } : null;
}
