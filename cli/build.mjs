#!/usr/bin/env node
/**
 * Build the command-line Slide Anonymizer.
 *
 *   node cli/build.mjs            bundle to cli/dist/slide-anonymizer.mjs (runs with Node >= 20)
 *   node cli/build.mjs --exe      also make stand-alone programs for Windows / macOS / Linux
 *                                 (needs the `deno` program on PATH or in DENO=...)
 *
 * The stand-alone programs need nothing installed on the user's computer.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const bundle = path.join(dist, 'slide-anonymizer.mjs');
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, 'anonymize-cli.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  alias: {
    '@': path.join(root, 'src'),
    '@empaia/wsi-anon': path.join(root, 'vendor/wsi-anon/bin/wsi-anon.js'),
  },
  // The Emscripten module in wsi-anon.js expects CommonJS globals under Node.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      "const __dirname = __filename.replace(/[\\\\/][^\\\\/]*$/, '');",
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`bundle: ${path.relative(root, bundle)} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB)`);

if (process.argv.includes('--exe')) {
  const deno = process.env.DENO || 'deno';
  const targets = [
    ['x86_64-pc-windows-msvc', 'slide-anonymizer-windows.exe'],
    ['aarch64-apple-darwin', 'slide-anonymizer-mac-apple-silicon'],
    ['x86_64-apple-darwin', 'slide-anonymizer-mac-intel'],
    ['x86_64-unknown-linux-gnu', 'slide-anonymizer-linux'],
  ];
  // Compile from an empty temp folder: next to package.json Deno would embed
  // the whole node_modules tree (~250 MB per program instead of ~100 MB).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-anonymizer-'));
  const entry = path.join(work, 'slide-anonymizer.mjs');
  fs.copyFileSync(bundle, entry);
  try {
    for (const [target, name] of targets) {
      const out = path.join(dist, name);
      execFileSync(deno, ['compile', '--quiet', '--no-check', '--no-config', '-A', '--target', target, '--output', out, entry],
        { stdio: 'inherit', cwd: work });
      console.log(`program: ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB)`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
