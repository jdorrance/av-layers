import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import swc from 'rollup-plugin-swc3';
import { transformCodeToESMPlugin } from '@windycom/plugin-devtools';

const apiBase = process.env.AV_API_BASE || 'http://localhost:8787';

export default {
  input: 'src/plugin.ts',
  output: [
    { file: 'dist/plugin.js', format: 'module', sourcemap: true },
    { file: 'dist/plugin.min.js', format: 'module', sourcemap: true, plugins: [terser()] }
  ],
  external: id => id.startsWith('@windy/'),
  onwarn: () => {},
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
          source: JSON.stringify({ name: '@av/windy-plugin', version: '0.1.0', type: 'module', main: 'plugin.min.js' }, null, 2)
        });
      }
    }
  ]
};
