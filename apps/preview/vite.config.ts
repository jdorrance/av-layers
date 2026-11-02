import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';

export default defineConfig({
  plugins: [{
    name: 'windy-plugin-assets',
    apply: 'build',
    async generateBundle() {
      for (const name of ['plugin.js', 'plugin.min.js', 'plugin.json', 'package.json']) {
        this.emitFile({ type: 'asset', fileName: `windy-plugin/${name}`, source: await readFile(new URL(`../windy-plugin/dist/${name}`, import.meta.url)) });
      }
    }
  }],
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist'
  }
});
