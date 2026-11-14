import { browserBundleBudget } from '../../scripts/browser-bundle.js';
import { defineConfig } from 'vite';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  envPrefix: ['VITE_', 'AV_API_BASE'],
  plugins: [browserBundleBudget(372_000, 31_000), {
    name: 'windy-plugin-assets',
    apply: 'build',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'MapLibre-LICENSE.txt', source: await readFile(join(require.resolve('maplibre-gl/package.json'), '..', 'LICENSE.txt')) });
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: await readFile(new URL('../../THIRD_PARTY_NOTICES.txt', import.meta.url)) });
      const directory = fileURLToPath(new URL('../windy-plugin/dist/', import.meta.url));
      for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        this.emitFile({ type: 'asset', fileName: `windy-plugin/${relative(directory, path).replaceAll('\\', '/')}`, source: await readFile(path) });
      }
    }
  }],
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist'
  }
});
