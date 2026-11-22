/**
 * Copy the Tesseract.js worker, WebAssembly core and English model from
 * node_modules into public/ocr/<version>/, so OCR is served by this site
 * (the page's CSP forbids CDNs, and label images must never leave the browser).
 * Versioned folder → the server can cache these files forever.
 */
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nm = (...p) => path.join(root, 'node_modules', ...p);
const version = async (pkg) =>
  JSON.parse(await readFile(nm(pkg, 'package.json'), 'utf8')).version;

export async function ocrAssetDir() {
  return `t${await version('tesseract.js')}-e${await version('@tesseract.js-data/eng')}`;
}

async function main() {
  const dirName = await ocrAssetDir();
  const outRoot = path.join(root, 'public', 'ocr');
  const out = path.join(outRoot, dirName);
  await mkdir(path.join(out, 'core'), { recursive: true });
  await mkdir(path.join(out, 'lang'), { recursive: true });
  // Remove assets of other versions.
  for (const name of await readdir(outRoot)) {
    if (name !== dirName) await rm(path.join(outRoot, name), { recursive: true, force: true });
  }
  const copies = [
    [nm('tesseract.js', 'dist', 'worker.min.js'), 'worker.min.js'],
    [nm('tesseract.js', 'dist', 'worker.min.js.LICENSE.txt'), 'worker.min.js.LICENSE.txt'],
    [nm('tesseract.js-core', 'LICENSE'), 'core/LICENSE'],
    [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), 'lang/eng.traineddata.gz'],
  ];
  // LSTM-only cores (WebAssembly embedded); the worker picks one by CPU support.
  for (const v of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
    const f = `tesseract-core-${v}.wasm.js`;
    copies.push([nm('tesseract.js-core', f), `core/${f}`]);
  }
  for (const [from, to] of copies) await copyFile(from, path.join(out, to));
  console.log(`OCR assets → public/ocr/${dirName}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
