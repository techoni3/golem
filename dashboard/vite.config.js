import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

export default defineConfig({
  root: path.join(here, 'web'),
  define: {
    __GOLEM_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
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
