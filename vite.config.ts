import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { ocrAssetDir } from './scripts/copy-ocr-assets.mjs';

// Built into dist/ and served by server/server.mjs behind the password gate.
export default defineConfig(async () => ({
  base: '/',
  plugins: [vue()],
  define: {
    // public/ocr/<dir>/ — written by scripts/copy-ocr-assets.mjs (pre-dev / pre-build).
    __OCR_ASSET_DIR__: JSON.stringify(await ocrAssetDir()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@empaia/wsi-anon': fileURLToPath(
        new URL('./vendor/wsi-anon/bin/wsi-anon.js', import.meta.url)
      ),
    },
  },
  optimizeDeps: {
    exclude: ['@empaia/wsi-anon'],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
}));
