import { defineConfig } from 'vite';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'web'),
  build: {
    target: 'esnext',
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7421',
      '/ws': { target: 'ws://127.0.0.1:7421', ws: true },
    },
  },
});
