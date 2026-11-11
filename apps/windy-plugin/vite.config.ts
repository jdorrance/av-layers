import { browserBundleBudget } from '../../scripts/browser-bundle.js';
import { defineConfig } from 'vite';
import { basename } from 'node:path';
import config from './src/pluginConfig';
import { main as entryPoint, type } from './package.json';

const built = Date.now();
const plugin = { ...config, built, builtReadable: new Date(built).toISOString() };
const main = basename(entryPoint);

export default defineConfig({
  envPrefix: 'AV_API_BASE',
  define: { __WINDY_CONFIG__: JSON.stringify(plugin) },
  build: {
    lib: { entry: 'src/plugin.ts', formats: ['es'], fileName: () => main },
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: true
  },
  plugins: [browserBundleBudget(98_000), {
    name: 'windy-metadata',
    generateBundle() {
      for (const [fileName, data] of Object.entries({
        'plugin.json': plugin,
        'package.json': { name: plugin.name, version: plugin.version, type, main }
      })) this.emitFile({ type: 'asset', fileName, source: JSON.stringify(data, null, 2) });
    }
  }]
});
