import { build } from 'vite';
import { expect, it } from 'vitest';
import { browserBundleBudget } from '../scripts/browser-bundle.js';

it('bundles the validated ApiClient without forecast or server modules', async () => {
  const entry = 'api-client-entry', resolved = '\0' + entry;
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [browserBundleBudget(42_000), {
      name: entry,
      resolveId(id) { if (id === entry) return resolved; },
      load(id) {
        if (id === resolved) return "export { ApiClient } from '@av/client';";
      }
    }],
    build: {
      write: false,
      target: 'es2022',
      minify: 'esbuild',
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { format: 'es' } }
    }
  });
  if (Array.isArray(built) || !('output' in built)) throw new Error('Expected an in-memory bundle');
  const chunks = built.output.filter(output => output.type === 'chunk');
  expect(chunks).toHaveLength(1);
  const chunk = chunks[0];
  expect(chunk.exports).toEqual(['ApiClient']);
  const emitted = Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => id);
  expect(emitted.some(id => id.includes('/node_modules/zod/'))).toBe(true);
  expect(emitted.some(id => id.endsWith('/contracts/src/publication.ts'))).toBe(true);
  expect(emitted.some(id => id.endsWith('/contracts/src/point-products.ts'))).toBe(true);
  expect(emitted.some(id => id.includes('/packages/forecast/'))).toBe(false);
});
