import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import swc from 'rollup-plugin-swc3';
import { transformCodeToESMPlugin } from '@windycom/plugin-devtools';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const apiBase = process.env.AV_API_BASE || 'http://localhost:8787';
const { name, version, type, main } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default {
  input: 'src/plugin.ts',
  output: [
    { file: 'dist/plugin.js', format: 'module', sourcemap: true },
    { file: 'dist/plugin.min.js', format: 'module', sourcemap: true, plugins: [terser()] }
  ],
  external: id => id.startsWith('@windy/'),
  plugins: [
    {
      name: 'define-api-base',
      transform(code, id) {
        if (!id.endsWith('pluginConfig.ts')) return null;
        return { code: code.split("'__AV_API_BASE__'").join(JSON.stringify(apiBase)), map: null };
      }
    },
    swc({ include: ['**/*.ts'], sourceMaps: true }),
    resolve({ browser: true, mainFields: ['module', 'jsnext:main', 'main'], preferBuiltins: false }),
    commonjs(),
    transformCodeToESMPlugin(),
    {
      name: 'emit-package-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'package.json',
          source: JSON.stringify({ name, version, type, main: basename(main) }, null, 2)
        });
      }
    }
  ]
};
