import { copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

/** Демо- і embed-сторінки з site/ → dist/; прибирає службові ._* (exFAT). */
function site(): Plugin {
  return {
    name: 'soldier-viewer-site',
    apply: 'build',
    closeBundle() {
      const out = resolve(root, 'dist');
      for (const f of readdirSync(resolve(root, 'site'))) {
        if (!f.startsWith('._')) copyFileSync(resolve(root, 'site', f), join(out, f));
      }
      const clean = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (f.startsWith('._')) rmSync(p, { force: true });
          else if (statSync(p).isDirectory()) clean(p);
        }
      };
      clean(out);
    },
  };
}

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173, cors: { origin: '*' } },
  plugins: [site()],
  build: {
    // Один ES-модуль dist/soldier-viewer.js; debug (lil-gui) — окремий чанк лише для ?debug=1.
    lib: { entry: resolve(root, 'src/index.ts'), formats: ['es'], fileName: () => 'soldier-viewer.js' },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022', // Safari 16+, Chrome/Firefox/Samsung Internet актуальні
    minify: true,
    copyPublicDir: true, // public/assets → dist/assets, public/config.json → dist/config.json
    // У lib-режимі Vite не мінімізує ES-вихід сам — вмикаємо на рівні rolldown.
    rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js', minify: true } },
  },
});
