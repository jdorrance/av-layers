import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

const include = ['{packages,apps,scripts,tests}/**/*.test.ts'];
const integration = [
  '**/*.integration.test.ts',
  'apps/api/test/runtime.test.ts',
  'apps/batch/src/{archive,raster-pool,render,whole-domain-v5}.test.ts',
  'apps/windy-plugin/src/bundle.test.ts',
  'scripts/sample-preview.test.ts'
];

export default defineConfig({
  test: {
    testTimeout: 30_000,
    fileParallelism: true,
    maxWorkers: Math.min(8, availableParallelism()),
    projects: [
      { extends: true, test: { name: 'unit', include, exclude: [...configDefaults.exclude, ...integration] } },
      { extends: true, test: { name: 'integration', include: integration } }
    ]
  }
});
